/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_assert = require('assert-plus');
var mod_sqlite = require('sqlite3');
var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_jsprim = require('jsprim');


var VE = mod_verror.VError;
var MultiError = mod_verror.MultiError;

function
Database(opts)
{
	var self = this;

	mod_assert.object(opts, 'opts');
	mod_assert.string(opts.db_path, 'db_path');
	mod_assert.arrayOfObject(opts.tables, 'tables');

	self.db_path = opts.db_path;
	self.db_db = null;
	self.db_state = 'preopen';
	self.db_tables = opts.tables;

	/*
	 * Check that each table has the expected format.
	 */
	var ALLOWED_PROPS = [ 't_name', 't_cols', 't_extra' ];
	for (var i = 0; i < self.db_tables.length; i++) {
		var t = self.db_tables[i];

		var extra = mod_jsprim.extraProperties(t, ALLOWED_PROPS);
		if (extra.length > 0) {
			throw (new VE('init(): extra properties %j: %j',
			    extra, t));
		}

		mod_assert.string(t.t_name, 't_name');
		mod_assert.arrayOfString(t.t_cols, 't_cols');
		mod_assert.optionalString(t.t_extra, 't_extra');
	}

	self.db_txn = null;
	self.db_txn_queue = [];
	self.db_txn_next_id = 1;
}

Database.prototype._open = function
_open(callback)
{
	var self = this;

	mod_assert.strictEqual(self.db_state, 'preopen', '_open()ed twice');

	var mode = mod_sqlite.OPEN_READWRITE | mod_sqlite.OPEN_CREATE;

	self.db_state = 'opening';
	self.db_db = new mod_sqlite.Database(self.db_path, mode,
	    function _on_open(err) {
		if (err) {
			self.db_state = 'error';
			callback(VE(err, 'SQLite open error: file "%s"',
			    self.db_path));
			return;
		}

		mod_vasync.waterfall([ function dbo_set_journal_mode(next) {
			self.db_state = 'set_journal_mode';
			self.db_db.exec('PRAGMA journal_mode = WAL',
			    function (err) {
				if (err) {
					next(VE(err,
					    'set journal mode to WAL'));
					return;
				}

				next();
			});

		}, function dbo_init_tables(next) {
			self.db_state = 'init_tables';
			self._init(next);

		} ], function (err) {
			if (err) {
				self.db_state = 'error';
				self.db_db.close(function (closeError) {
					if (closeError) {
						console.error('WARNING: %s',
						    closeError.message);
					}

					callback(VE(err, 'SQLite startup ' +
					    'error: file "%s"',
					    self.db_path));
				});
				return;
			}

			self.db_state = 'open';
			setImmediate(self._switch_txn.bind(self));
			callback();
		});
	});
};

Database.prototype.start_txn_deferred = function
start_txn_deferred(arg, txn_func, callback)
{
	var self = this;

	mod_assert.func(txn_func, 'txn_func');
	mod_assert.func(callback, 'callback');

	var txn = {
		txn_id: self.db_txn_next_id++,
		txn_func: txn_func,
		txn_callback: callback,
		txn_arg: arg,
		txn_open: false,
		txn_type: 'deferred',
	};

	self.db_txn_queue.push(txn);

	if (self.db_state !== 'open') {
		return;
	}

	setImmediate(self._switch_txn.bind(self));
};

Database.prototype.start_txn = function
start_txn(arg, txn_func, callback)
{
	var self = this;

	mod_assert.func(txn_func, 'txn_func');
	mod_assert.func(callback, 'callback');

	var txn = {
		txn_id: self.db_txn_next_id++,
		txn_func: txn_func,
		txn_callback: callback,
		txn_arg: arg,
		txn_open: false,
		txn_type: 'immediate',
	};

	self.db_txn_queue.push(txn);

	if (self.db_state !== 'open') {
		return;
	}

	setImmediate(self._switch_txn.bind(self));
};

Database.prototype._switch_txn = function
_switch_txn()
{
	var self = this;

	if (self.db_txn !== null || self.db_txn_queue.length < 1) {
		return;
	}

	var txn = self.db_txn = self.db_txn_queue.shift();

	var resched = function () {
		setImmediate(function () {
			self.db_txn = null;
			self._switch_txn();
		});
	};

	var q = 'BEGIN ' + txn.txn_type.toUpperCase();

	self.db_db.exec(q, function (err) {
		if (err) {
			resched();
			txn.txn_callback(VE(err, 'start_txn %s', q));
			return;
		}

		txn.txn_open = true;

		txn.txn_func({
			db: function () {
				if (!txn.txn_open) {
					throw (new VE('txn not open'));
				}

				return (self.db_db);
			},
			finish: function (opts) {
				mod_assert.object(opts, 'opts');
				mod_assert.optionalObject(opts.error, 'opts.error');
				mod_assert.bool(opts.commit, 'opts.commit');
				mod_assert.optionalArray(opts.args, 'opts.array');

				if (!txn.txn_open) {
					throw (new VE('txn not open'));
				}
				txn.txn_open = false;

				var errors = [];
				if (opts.error) {
					errors.push(opts.error);
				}

				var q = opts.commit ? 'COMMIT' : 'ROLLBACK';
				self.db_db.exec(q, function (err) {
					resched();

					if (err) {
						errors.push(VE(err,
						    'start_txn %s', q));
					}

					var args = opts.args ? opts.args : [];
					args.unshift(VE.errorFromList(errors));

					txn.txn_callback.apply(null, args);
				});
			}
		}, txn.txn_arg);
	});
};

/*
 * Set up the schema.
 */
Database.prototype._init = function
_init(done)
{
	var self = this;

	mod_assert.arrayOfObject(self.db_tables, 'db_tables');
	mod_assert.func(done, 'done');

	mod_vasync.forEachPipeline({
		func: function makeTable(t, next) {
			var q = 'CREATE TABLE IF NOT EXISTS ' + t.t_name +
			    ' (\n    ' + t.t_cols.join(',\n    ') + '\n)';

			if (t.t_extra) {
				q += ' ' + t.t_extra;
			}

			self.db_db.exec(q, function (err) {
				if (err) {
					next(VE(err, 'create table "%s"',
					    t.t_name));
					return;
				}

				next();
			});
		},
		inputs: self.db_tables
	}, done);
};

Database.prototype.close = function
close(done)
{
	var self = this;

	if (self.db_state !== 'open') {
		throw (new Error('double close()'));
	}
	self.db_state = 'closing';

	self.db_db.close(function on_close(err) {
		if (err) {
			self.db_state = 'error';
			done(VE(err, 'closing database'));
			return;
		}

		self.db_state = 'closed';
		self.db_db = null;

		if (done) {
			done();
		}
	});
};

module.exports = {
	create_database: function create_database(opts, callback) {
		var db = new Database(opts);

		db._open(function (err) {
			if (err) {
				callback(err);
				return;
			}

			callback(null, db);
		});
	}
};
