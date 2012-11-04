#!/usr/bin/env node

var Logger = require('bunyan');
var path = require('path');
var sqlite3 = require('sqlite3').verbose();

var log = new Logger({name: "provis.database"});


var DBFILE = path.join(__dirname, '..', 'DATA.sqlite3');

var db = new sqlite3.Database(DBFILE);
createSchema();
db.serialize();

function createTable(table)
{
  var q = 'CREATE TABLE IF NOT EXISTS ' + table.name + ' (';
  for (var i = 0; i < table.columns.length; i++) {
    var col = table.columns[i];
    q += col.name + ' ' + col.type;
    if (i !== table.columns.length - 1)
      q += ', ';
  }
  if (table.primary)
    q += ', PRIMARY KEY (' + table.primary + ')';
  q += ')';
  /*console.log(q);*/
  db.exec(q);
}

function createSchema()
{
  createTable({
    name: 'keys',
    columns: [
      { name: 'uuid', type: 'TEXT' },
      { name: 'alias', type: 'TEXT' },
      { name: 'ssh_key', type: 'TEXT' }
    ],
    primary: 'uuid'
  });
}

function getKey(uuid, callback)
{
  var q = 'SELECT * FROM keys WHERE uuid = ?';
  db.get(q, uuid, function(err, row) {
    return callback(err, row);
  });
}

function addKey(uuid, alias, ssh_key, callback)
{
  var q = 'INSERT INTO keys (uuid, alias, ssh_key) ' +
    ' VALUES (?, ?, ?)';
  db.run(q, uuid, alias, ssh_key, function(err) {
    return callback(err);
  });
}

module.exports = {
  createSchema: createSchema,
  getKey: getKey,
  addKey: addKey
};
