#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_net = require('net');

var mod_assert = require('assert-plus');
var mod_http_sig = require('http-signature');
var mod_bunyan = require('bunyan');
var mod_restify = require('restify');
var mod_vasync = require('vasync');
//var mod_verror = require('verror');

var lib_jpc = require('../lib/jpc');

//var VE = mod_verror.VError;


function
from_localhost(req, res, next)
{
	if (req.connection.remoteAddress !== '127.0.0.1') {
		next(new Error('requests must come from localhost'));
		return;
	}

	var ip = req.headers['x-real-ip'];
	if (!ip || !mod_net.isIPv4(ip.trim())) {
		next(new Error('requests must have header X-Real-IP'));
		return;
	}

	req.p_ip = ip;
	next();
}

function
check_signature(req, res, next)
{
	var p;

	try {
		p = mod_http_sig.parseRequest(req);
	} catch (ex) {
		req.log.info(ex, 'invalid signature');
		res.send(403);
		next(false);
		return;
	}

	req.log.info({ sig: p }, 'parsed signature');

	var m;
	if ((m = p.params.keyId.match(/^zone:([a-f0-9-]+)$/)) !== null) {
		/*
		 * This might be the zone-level SSH key for a particular zone.
		 */
		var z = m[1];

		lib_jpc.get_pubkey_zone(z, function (err, pk) {
			if (err) {
				res.send(403);
				next(false);
				return;
			}

			if (pk === null) {
				req.log.info('no public key for zone "%s"', z);
				res.send(403);
				next(false);
				return;
			}

			req.log.info({ pk: pk },
			    'found public key for zone "%s"', z);

			if (!mod_http_sig.verifySignature(p, pk)) {
				req.log.info('signature check failure');
				res.send(403);
				next(false);
				return;
			}

			req.p_auth = true;
			req.p_zone = z;
			req.log.info('auth ok for zone %s', z);
			next();
		});
		return;
	}

	res.send(403);
	next(false);
}

function
get_hosts(req, res, next)
{
	mod_assert.ok(req.p_auth, 'expected authentication');

	req.log.info('get hosts');

	lib_jpc.make_hosts(function (err, hosts) {
		if (err) {
			res.send(err);
			next(false);
			return;
		}

		res.contentType = 'text/plain';
		res.send(200, hosts.join('\n') + '\n');
		next();
	});
}

function
create_server(log, callback)
{
	var s = mod_restify.createServer({ log: log });
	s.use(mod_restify.plugins.bodyParser());
	s.use(from_localhost);

	s.use(mod_restify.plugins.requestLogger({
		headers: [ 'x-real-ip' ]
	}));

	s.get('/provis/hosts', check_signature, get_hosts);

	s.on('after', mod_restify.plugins.auditLogger({
		log: log.child({ audit: true }),
		event: 'after',
		server: s
	}));

	var PORT = 8095;
	s.listen(PORT, '127.0.0.1', function() {
		log.info('listening on %d', 8095);

		setImmediate(callback, null, s);
	});
}

setImmediate(function
main()
{
	var log = mod_bunyan.createLogger({
		name: 'provis',
		level: process.env.LOG_LEVEL || mod_bunyan.INFO
	});

	mod_vasync.pipeline({ arg: {}, funcs: [ function (_, next) {
		lib_jpc.load_dc_list(next);

	}, function (_, next) {
		create_server(log, next);

	}]}, function (err) {
		if (err) {
			log.fatal(err, 'startup failure');
			process.exit(1);
		}

		log.info('startup ok');
	});
});
