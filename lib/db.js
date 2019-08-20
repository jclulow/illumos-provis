/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_fs = require('fs');
var mod_path = require('path');

var mod_assert = require('assert-plus');
var mod_sqlite = require('sqlite3');
var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_jsprim = require('jsprim');

var lib_db_base = require('./db_base');


var VE = mod_verror.VError;
var MultiError = mod_verror.MultiError;

function
make_columns(obj)
{
	return (Object.keys(obj).map(function (k) {
		return (obj[k] + ' AS "' + k + '"');
	}).join(', '));
}

function
$(f)
{
	mod_assert.string(f, 'f');

	return ('$' + f);
}

function
build_update(table, fields, where)
{
	mod_assert.string(table, 'table');
	mod_assert.arrayOfString(fields, 'fields');
	mod_assert.string(where, 'where');

	mod_assert.ok(fields.length > 0, 'no fields?!');

	var q = 'UPDATE ' + table + ' SET ';

	q += fields.map(function (f) {
		return (f + ' = $' + f);
	}).join(', ');

	q += ' WHERE ' + where + ' = $' + where;

	return (q);
}

function
DB(db)
{
	var self = this;

	mod_assert.object(db, 'db');

	self.db_db = db;

	self.close = self.db_db.close.bind(self.db_db);
}

DB.prototype.etchosts = function
etchosts(callback)
{
	var self = this;

	self.db_db.start_txn({}, self._etchosts.bind(self),
	    callback);
};

DB.prototype._etchosts = function
_etchosts(txn, opts)
{
	var self = this;

	var q = 'SELECT * FROM etchosts';
	var p = [];

	txn.db().all(q, p, function (err, rows) {
		if (err) {
			txn.finish({ commit: false, error: err });
			return;
		}

		txn.finish({
			commit: true,
			args: [ rows ? rows : [] ],
		});
	});
};

DB.prototype.hostid_pubkey = function
hostid_pubkey(hostid, callback)
{
	var self = this;

	var opts = {
		hostid: hostid
	};

	self.db_db.start_txn(opts, self._hostid_pubkey.bind(self),
	    callback);
};

DB.prototype._hostid_pubkey = function
_hostid_pubkey(txn, opts)
{
	var self = this;

	/*
	 * Check to see if there is a host with this hostid.
	 */
	var q = 'SELECT * FROM hostid WHERE hostid = ?';
	var p = [ opts.hostid ];

	txn.db().get(q, p, function (err, row) {
		if (err) {
			txn.finish({ commit: false, error: err });
			return;
		}

		txn.finish({
			commit: true,
			args: [
				row !== undefined ? row.pubkey : null
			]
		});
	});
};

DB.prototype.telegram_user_load = function
telegram_user_load(opts, callback)
{
	var self = this;

	self.db_db.start_txn(opts, self._telegram_user_load.bind(self),
	    callback);
};

DB.prototype._telegram_user_load = function
_telegram_user_load(txn, opts)
{
	var self = this;

	var tgu = null;

	mod_vasync.pipeline({ arg: {}, funcs: [ function (_, next) {
		/*
		 * Check to see if this record exists already.
		 */
		var q = 'SELECT * FROM telegram_user WHERE id = ?';
		var p = [ opts.id ];

		txn.db().get(q, p, function (err, row) {
			if (err) {
				next(err);
				return;
			}

			if (row !== undefined) {
				tgu = {
					tgu_id: row.id,
					tgu_from: JSON.parse(row.json),
					tgu_allow: !!row.allow,
					tgu_notified: !!row.notified,
				};
				next();
				return;
			}

			next();
		});

	}, function (_, next) {
		if (tgu !== null) {
			setImmediate(next);
			return;
		}

		var q = 'INSERT INTO telegram_user (id, json) VALUES (?, ?)';
		var p = [ opts.id, JSON.stringify(opts.from) ];

		txn.db().get(q, p, next);

	}, function (_, next) {
		if (tgu !== null) {
			setImmediate(next);
			return;
		}

		tgu = {
			tgu_id: opts.id,
			tgu_from: mod_jsprim.deepCopy(opts.from),
			tgu_allow: false,
			tgu_notified: false,
		};
		setImmediate(next);

	} ] }, function (err) {
		txn.finish({ commit: !err, error: err, args: [ tgu ] });
	});
};

/*
 * XXX This must be run in a transaction to make sense.  If you don't
 * end up using the sequence number we assign, you should roll back.
 */
DB.prototype._seq_next = function
_seq_next(txn, name, callback)
{
	var self = this;

	/*
	 * XXX check "db_txn" to make sure it isn't null?
	 */

	var our_id = null;

	mod_vasync.waterfall([ function sqn_get_current(next) {
		var q = 'SELECT next_id FROM seq WHERE name = ?';
		var p = [ name ];

		txn.db().get(q, p, function (err, row) {
			next(err, row);
		});
	}, function sqn_update(row, next) {
		if (row) {
			/*
			 * The sequence exists already.
			 */
			our_id = row.next_id;
		} else {
			/*
			 * The sequence does not exist.  Take the first
			 * slot, and we'll create the sequence record
			 * with a next_id of 2.
			 */
			our_id = 1;
		}

		var q = 'INSERT OR REPLACE INTO seq (name, next_id) ' +
		    'VALUES (?, ?)';
		var p = [ name, our_id + 1 ];
		txn.db().get(q, p, function (err) {
			next(err);
		});
	} ], function sqn_final(err) {
		if (err) {
			callback(VE(err, 'getting next in sequence "%s"',
			    name));
			return;
		}

		callback(null, our_id);
	});
};

module.exports = {
	db_open: function create_database(callback) {
		var path = mod_path.join(__dirname, '..', 'var',
		    'provis.sqlite3');

		lib_db_base.create_database({ db_path: path, tables: [
			{
				t_name: 'seq',
				t_cols: [
					'name TEXT PRIMARY KEY',
					'next_id INTEGER NOT NULL DEFAULT 1',
				]
			}, {
				t_name: 'telegram_user',
				t_cols: [
					'id INTEGER PRIMARY KEY',
					'json TEXT NOT NULL',
					'allow INTEGER NOT NULL DEFAULT 0',
					'notified INTEGER NOT NULL DEFAULT 0',
				]
			}, {
				t_name: 'hostid',
				t_cols: [
					'hostid TEXT PRIMARY KEY',
					'hostname TEXT NOT NULL',
					'pubkey TEXT NOT NULL',
				]
			}, {
				t_name: 'etchosts',
				t_cols: [
					'ipaddr TEXT PRIMARY KEY',
					'hostname TEXT NOT NULL',
					'environ TEXT NOT NULL',
				]
			}
		] }, function (err, db) {
			if (err) {
				callback(new VE(err, 'db_open file "%s"',
				    path));
				return;
			}

			callback(null, new DB(db));
		});
	}
};
