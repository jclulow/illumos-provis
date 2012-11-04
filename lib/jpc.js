

var sprintf = require('sprintf').sprintf;
var smartdc = require('smartdc');
var fs = require('fs');
var path = require('path');

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

function makeHosts(callback) {
  client.listMachines(function(err, machines) {
    if (err)
      return callback(err);

    var lines = [];
    var FMT = '%-16s %s';
    lines.push(sprintf(FMT, '127.0.0.1', 'localhost loghost'));
    lines.push(sprintf(FMT, '::1', 'localhost'));
    for (var i = 0; i < machines.length; i++) {
      var m = machines[i];
      for (var j = 0; j < m.ips.length; j++) {
        var ip = m.ips[j];
        var hostname = ip.match(/^10\./) ? m.name + DOMAIN_INT :
          m.name + DOMAIN_EXT + ' ' + m.name;
        lines.push(sprintf(FMT, ip, hostname));
      }
    }

    return callback(null, lines);
  });
}

function getMachineByIP(searchIP, callback) {
  client.listMachines(function(err, machines) {
    if (err)
      return callback(err);

    for (var i = 0; i < machines.length; i++) {
      var m = machines[i];
      if (m.ips.indexOf(searchIP) !== -1)
        return callback(null, m);
    }
    return callback();
  });
}

function clearScript(uuid, callback) {
  client.deleteMachineMetadata(uuid, 'user-script', function(err) {
    return callback(err);
  });
}

module.exports = {
  getMachineByIP: getMachineByIP,
  clearScript: clearScript,
  makeHosts: makeHosts
};
