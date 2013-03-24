

var sprintf = require('sprintf').sprintf;
var smartdc = require('smartdc');
var fs = require('fs');
var path = require('path');
var Logger = require('bunyan');
var log = new Logger({name: "provis.listener.jpc"});

var CONFIG = require(path.join(process.env.HOME, '.jpc.json'));

var ACCOUNT = CONFIG.account;
var KEYID = CONFIG.keyid;
var KEYFILE = path.join(process.env.HOME, '.ssh', KEYID);
var KEY = fs.readFileSync(KEYFILE, 'ascii');

var DOMAIN_EXT = CONFIG.domain.ext;
var DOMAIN_INT = CONFIG.domain.int;

var client = smartdc.createClient({
    url: 'https://api.joyentcloud.com',
    key: KEY,
    keyId: '/' + ACCOUNT + '/keys/' + KEYID
});

var clients = [];

client.listDatacenters(function(err, dclist) {
  var dckeys = Object.keys(dclist);
  for (var i = 0; i < dckeys.length; i++) {
    var dcurl = dclist[dckeys[i]];
    clients.push(smartdc.createClient({
      url: dcurl,
      key: KEY,
      keyId: '/' + ACCOUNT + '/keys/' + KEYID
    }));
  }
  log.info({ datacentres: dclist }, "retrieved list of active " +
    "datacentres");
});

function makeHosts(callback) {
  var done = false;
  var outstanding = clients.length;

  var lines = [];
  var FMT = '%-16s %s';
  lines.push(sprintf(FMT, '127.0.0.1', 'localhost loghost'));
  lines.push(sprintf(FMT, '::1', 'localhost'));

  var cb = function makeHostsInternal(err, machines) {
    if (done)
      return;
    outstanding--;
    if (err) {
      done = true;
      return (callback(err));
    }
    for (var i = 0; i < machines.length; i++) {
      var m = machines[i];
      for (var j = 0; j < m.ips.length; j++) {
        var ip = m.ips[j];
        var hostname = ip.match(/^10\./) ? m.name + DOMAIN_INT :
          m.name + DOMAIN_EXT + ' ' + m.name;
        lines.push(sprintf(FMT, ip, hostname));
      }
    }
    if (outstanding === 0) {
      done = true;
      return callback(null, lines);
    }
  };

  for (var i = 0; i < clients.length; i++) {
    clients[i].listMachines(cb);
  }
}

function getMachineByIP(searchIP, callback) {
  var done = false;
  var outstanding = clients.length;

  var cb = function getMachineByIPInternal(err, machines) {
    if (done)
      return;
    outstanding--;
    if (err) {
      done = true;
      return (callback(err));
    }
    for (var i = 0; i < machines.length; i++) {
      var m = machines[i];
      if (m.ips.indexOf(searchIP) !== -1) {
        done = true;
        return callback(null, m);
      }
    }
    if (outstanding === 0) {
      done = true;
      return callback();
    }
  };

  for (var i = 0; i < clients.length; i++)
    clients[i].listMachines(cb);
}

module.exports = {
  getMachineByIP: getMachineByIP,
  makeHosts: makeHosts
};
