/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_path = require('path');
var mod_util = require('util');
var mod_events = require('events');

var mod_assert = require('assert-plus');
var mod_restify_clients = require('restify-clients');
var mod_verror = require('verror');
var mod_vasync = require('vasync');

var VE = mod_verror.VError;


function
BotClient(opts)
{
	var self = this;

	mod_assert.object(opts, 'opts');
	mod_assert.string(opts.token, 'opts.token');
	mod_assert.object(opts.log, 'opts.log');
	mod_assert.func(opts.update_func, 'opts.update_func');

	mod_events.EventEmitter.call(self);

	self.bc_token = opts.token;
	self.bc_log = opts.log;
	self.bc_update_func = opts.update_func;

	self.bc_json = mod_restify_clients.createJsonClient({
		url: 'https://api.telegram.org'
	});

	self.bc_long_poll_timeout = 30;

	self.bc_polling = false;
	self.bc_highest_update_id = null;

	setImmediate(function () {
		self._poll();
	});
}
mod_util.inherits(BotClient, mod_events.EventEmitter);

BotClient.prototype.send_message = function
send_message(opts, callback)
{
	var self = this;

	mod_assert.object(opts, 'opts');
	mod_assert.number(opts.target_id, 'opts.target_id');
	mod_assert.string(opts.message, 'opts.message');
	mod_assert.string(opts.format, 'opts.format');

	/*
	 * XXX
	 */
	mod_assert.ok(opts.format === 'html', 'format must be "html"');

	var reqopts = {
		path: '/bot' + self.bc_token + '/sendMessage',
	};

	var body = {
		chat_id: opts.target_id,
		text: opts.message,
		parse_mode: 'HTML',
	};

	self.bc_json.post(reqopts, body, function (err, req, res, obj) {
		if (err) {
			callback(VE(err, 'send message failed'));
			return;
		}

		self.bc_log.trace({
			req: req,
			res: res,
			obj: obj
		}, 'sendMessage result');

		if (typeof (obj.ok) !== 'boolean') {
			callback(VE({ info: { result: obj }},
			    'sendMessage result missing "ok"'));
			return;
		}

		if (!obj.ok) {
			callback(VE({ info: { result: obj }},
			    'sendMessage fail result'));
			return;
		}

		callback();
	});
};

BotClient.prototype._poll = function
_poll()
{
	var self = this;

	if (self.bc_polling) {
		return;
	}
	self.bc_polling = true;

	var reqopts = {
		path: '/bot' + self.bc_token + '/getUpdates',
		connectTimeout: 15 * 1000,
		requestTimeout: 1.5 * self.bc_long_poll_timeout * 1000,
		retry: false
	};

	var body = {
		timeout: self.bc_long_poll_timeout
	};
	if (self.bc_highest_update_id !== null) {
		body.offset = self.bc_highest_update_id + 1;
	}

	self.bc_log.debug({ body: body }, 'poll for updates');

	self.bc_json.post(reqopts, body, function (err, req, res, obj) {
		self.bc_log.debug({
			req: req,
			res: res,
			obj: obj
		}, 'getUpdates result');

		if (err) {
			self.bc_log.error(err, 'POST /getUpdates');
		}

		var resched = function () {
			self.bc_polling = false;
			setTimeout(function () {
				self._poll();
			}, 1000);
		};

		if (typeof (obj.ok) !== 'boolean') {
			self.bc_log.error('getUpdates response did not have ' +
			    '"ok"');
			resched();
			return;
		}

		if (!Array.isArray(obj.result)) {
			self.bc_log.error('getUpdates response did not have ' +
			    '"result"');
			resched();
			return;
		}

		mod_vasync.forEachPipeline({ inputs: obj.result,
		    func: function (u, next) {
			self.bc_update_func(u, function () {
				/*
				 * We need to remember the highest update ID
				 * we've seen.
				 */
				if (self.bc_highest_update_id === null ||
				    self.bc_highest_update_id < u.update_id) {
					self.bc_highest_update_id = u.update_id;
				}

				setImmediate(next);
			});
		}}, resched);
	});
};


function
create_bot(opts, callback)
{
	var bc = new BotClient(opts);

	setImmediate(function () {
		callback(null, bc);
	});
}

module.exports = {
	create_bot: create_bot
};
