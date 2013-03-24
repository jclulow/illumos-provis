#!/usr/bin/env node

var Logger = require('bunyan');
var restify = require('restify');
var log = new Logger({name: "provis.listener"});
var path = require('path');
var httpSig = require('http-signature');
var $ = require('async');

var rndpass = require('./lib/rndpass');
var db = require('./lib/database');
var jpc = require('./lib/jpc');
var gh = require('./lib/ghwrap');

var s = restify.createServer({ log: log });
s.use(restify.bodyParser());
s.use(fromLocalhost);

/*
function fromInternet(req, res, next) {
  req.sourceIP = req.connection.remoteAddress;
  return next();
}
*/
function fromLocalhost(req, res, next) {
  if (req.connection.remoteAddress === '127.0.0.1') {
    if (!req.headers['x-real-ip']) {
      return next(new Error('requests must have header X-Real-IP'));
    } else {
      req.sourceIP = req.headers['x-real-ip'];
      return next();
    }
  } else {
    return next(new Error('requests must come from localhost'));
  }
}

/*
s.get('/provis/info/:name', sigAuth, function(req, res, next) {
  if (req.params.name !== req.keyId)
    return res.send(400);
  res.send(200, {
    nodename: req.keyId,
    mq: {
      host: 'sampler',
      login: 'system/' + req.keyId,
      password: rndpass(32)
    }
  });
});
*/

var hosts_cache = null;
var hosts_timeout = null;
var hosts_queue = [];

function invalidateHosts(byTimer)
{
  if (hosts_timeout !== null) {
    clearTimeout(hosts_timeout);
    hosts_timeout = null;
  }
  if (hosts_cache !== null) {
    log.info('hosts cache invalidated by ' +
      (byTimer ? 'timer' : 'force'));
    hosts_cache = null;
  }
}

function getHosts(callback)
{
  if (hosts_cache !== null)
    return callback(null, hosts_cache);

  hosts_queue.push(callback);
  if (hosts_queue.length > 1)
    return;

  jpc.makeHosts(function(err, hosts) {
    if (err) {
      log.error('could not fetch hosts', err);
      while (hosts_queue.length > 0) {
        hosts_queue.pop()(err);
      }
      return;
    }
    log.info('/etc/hosts updated from JPC (' +
      hosts.length + ' entries)');

    hosts_cache = hosts.join('\n') + '\n';
    hosts_timeout = setTimeout(function() { invalidateHosts(true); },
      3600 * 1000); /* 1 hour */

    while (hosts_queue.length > 0) {
      hosts_queue.pop()(null, hosts_cache);
    }
  });
}

s.get('/provis/hosts', function(req, res, next) {
  log.info('/etc/hosts request from ' + req.sourceIP);
  res.contentType = 'text/plain';
  getHosts(function(err, hosts) {
    if (err)
      return res.send(500);
    else
      return res.send(200, hosts);
  });
});

s.post('/provis/registerkey', function(req, res, next) {
  var logo = { client: req.sourceIP,
    path: req.path,
    params: req.params
  };
  log.info('register key request', logo);

  /* args check */
  var alias = req.params.alias;
  var ssh_key = req.params.ssh_key;
  var source_ip = req.sourceIP;
  var machine = null;
  var key_in_github = false;
  var key_in_database = false;
  if (!alias || !ssh_key) {
    log.error('missing alias or ssh_key', logo);
    return res.send(400);
  }

  $.series([
    function rk_findInJPC(next) {
      /*
       * Interrogate the JPC to see if we know about
       * a machine with this IP address.
       */
      jpc.getMachineByIP(source_ip, function(err, result) {
        if (err) return next(err);

        log.info(result);
        if (!result) {
          /* no machine found for this IP */
          return next({ status: 400, message: 'unknown machine' });
        }

        if (result.name !== result.metadata.alias ||
          result.name !== alias) {
          /*
           * The name and alias from JPC and the alias from the
           * client should all match.
           */
          return next({ status: 400, message: 'mismatched alias' });
        }

        machine = result;
        log.info('found machine @ ' + source_ip, machine);
        return next();
      });
    },
    function rk_findInDatabase(next) {
      /*
       * Now that we have a machine UUID from the JPC,
       * look for a key in the database for this machine.
       */
      db.getKey(machine.id, function(err, row) {
        if (err) return next(err);

        if (row) {
          key_in_database = key_in_github = true;
          /* there is already a key.  make sure it matches. */
          if (row.ssh_key.trim() !== ssh_key.trim())
            return next({ status: 400,
              message: 'existing key does not match'
            });
        } else {
          /*
           * We appear to have a new host, so we should take this
           * opportunity to forget what we know about the hosts
           * table.
           */
          invalidateHosts();
        }

        return next();
      });
    },
    function rk_sendKeyToGithub(next) {
      if (key_in_github)
        return next();

      gh.addKey(machine.id, ssh_key, function(err, result) {
        if (err) return next(err);

        log.info('key added to github', result);
        key_in_github = true;
        return next();
      });
    },
    function rk_storeKeyInDatabase(next) {
      if (key_in_database)
        return next();

      db.addKey(machine.id, machine.name, ssh_key, function (err) {
        if (err) return next(err);

        log.info('key added to database: %s', ssh_key);
        key_in_database = true;
        return next();
      });
    }
  ], function rk_final(err, results) {
    logo.key_in_github = key_in_github;
    logo.key_in_database = key_in_database;
    logo.uuid = machine ? machine.id : '<none>';
    logo.ips = machine ? machine.ips : '<none>';
    if (err) {
      logo.error = err; log.error(logo);
      if (typeof (err.status) === 'number') {
        return res.send(err.status, { error: err.message });
      } else {
        return res.send(500, { error: 'sigh face' });
      }
    }
    log.info('request complete', logo);
    return res.send(200, { message: 'ok' });
  });
});

function sigAuth(req, res, next)
{
  var parsed;
  var pub;
  var opts = {};
  if (['HEAD', 'GET', 'DELETE'].indexOf(req.method) !== -1) {
    opts.headers = ['x-request-line', 'host', 'date'];
  } else {
    opts.headers = ['x-request-line', 'host', 'date', 'content-type',
      'content-md5', 'content-length'];
  }
  if (req.headers['x-request-line'] !== (req.method + ' ' + req.url)) {
    log.error({
      expected: req.method + ' ' + req.url,
      actual: req.headers['x-request-line']
    });
    return res.send(401, { error: 'malformed X-Request-Line' });
  }
  try {
    parsed = httpSig.parse(req);
    log.info({ client: req.sourceIP, signature: parsed });
  } catch (err) {
    log.error('parsing signature', err);
    return res.send(401, { error: 'signature error' });
  }
  /* load key from database */
  var q = 'SELECT * FROM keys WHERE name = ? AND active = 1';
  db.get(q, parsed.keyId, function(err, row) {
    if (err) {
      log.error('fetching key', { client: req.sourceIP, error: err });
      return res.send(500, { error: 'db error' });
    }
    if (!row) {
      log.error('no active key found', { client: req.sourceIP });
      return res.send(401, { error: 'access denied' });
    }
    pub = httpSig.sshKeyToPEM(row.ssh_key);
    log.info({ parsed: parsed });
    log.info({ headers: req.headers, key: row.ssh_key, pub: pub });
    if (!httpSig.verifySignature(parsed, pub)) {
      log.info('access denied', {
        client: req.sourceIP,
        keyId: parsed.keyId
      });
      return res.send(401, { error: 'access denied' });
    } else {
      log.info('access ok', {
        client: req.sourceIP,
        keyId: parsed.keyId
      });
      req.keyId = parsed.keyId;
      return next();
    }
  });
}

var PORT = 8095;
s.listen(PORT, 'localhost', function() {
  log.info('listening on %d', 8095);
});
