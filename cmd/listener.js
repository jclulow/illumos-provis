#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_net = require('net');
var mod_path = require('path');
var mod_fs = require('fs');

var mod_assert = require('assert-plus');
var mod_http_sig = require('http-signature');
var mod_bunyan = require('bunyan');
var mod_restify = require('restify');
var mod_vasync = require('vasync');
var mod_verror = require('verror');

var lib_jpc = require('../lib/jpc');
var lib_bot = require('../lib/bot');
var lib_db = require('../lib/db');

var VE = mod_verror.VError;


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

function
create_bot(log, db, callback)
{
	/*
	 * First, load the bot access token from disk.
	 */
	var p = mod_path.join(__dirname, '..', 'var', 'token.txt');
	if (!mod_fs.existsSync(p)) {
		log.info('no Telegram token file (%s); skipping bot', p);
		setImmediate(callback);
		return;
	}

	var tok = mod_fs.readFileSync(p, 'utf8').trim();
	var bot;

	log.info('starting Telegram bot');

	lib_bot.create_bot({ token: tok, log: log.child({ component: 'bot' }),
	    update_func: function (u, next) {
		log.info({ update: u }, 'telegram bot "update"');

		log = log.child({ update_id: u.update_id });

		if (typeof (u.message) !== 'object') {
			log.info('not a message');
			setImmediate(next);
			return;
		}

		var m = u.message;

		if (!m.chat || m.chat.type !== 'private') {
			log.info('not a private chat');
			setImmediate(next);
			return;
		}

		if (!m.from || m.from.is_bot || typeof (m.from.id) !== 'number') {
			log.info('not a proper private message from a user');
			setImmediate(next);
			return;
		}

		var logu = log.child({ user: m.from });
		logu.info('ok, it is a message...');

		db.telegram_user_load({ id: m.from.id, from: m.from },
		    function (err, tgu) {
			if (err) {
				logu.error(err, 'database get failure');
				return;
			}

			if (!tgu.tgu_allow) {
				logu.info('sending no-auth message');
				bot.send_message({ target_id: m.from.id,
				    format: 'html',
				    message: 'not authorised' },
				    function (err) {
					if (err) {
						logu.error(err,
						    'send message failure');
					} else {
						logu.info('message sent');
					}

					next();
				});
				return;
			}

			logu.info('sending auth message');
			bot.send_message({ target_id: m.from.id,
			    format: 'html',
			    message: 'ok!' },
			    function (err) {
				next();
			});
		});

	}}, function (err, _bot) {
		if (err) {
			callback(new VE(err, 'bot init failed'));
			return;
		}

		bot = _bot;

		callback();
	});
}

setImmediate(function
main()
{
	var log = mod_bunyan.createLogger({
		name: 'provis',
		level: process.env.LOG_LEVEL || mod_bunyan.INFO,
		serializers: mod_bunyan.stdSerializers
	});

	var db;

	mod_vasync.pipeline({ arg: {}, funcs: [ function (_, next) {
		lib_jpc.load_dc_list(next);

	}, function (_, next) {
		lib_db.db_open(function (err, _db) {
			if (err) {
				next(err);
				return;
			}

			db = _db;
			next();
		});

	}, function (_, next) {
		create_bot(log, db, next);

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
