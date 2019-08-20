

var mod_extsprintf = require('extsprintf');
var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_jsprim = require('jsprim');

var smartdc = require('smartdc');
var fs = require('fs');
var path = require('path');
var Logger = require('bunyan');
var log = new Logger({name: 'provis.listener.jpc'});

var sprintf = mod_extsprintf.sprintf;
var VE = mod_verror.VError;

var CONFIG = require(path.join(__dirname, '..', 'var', 'jpc.json'));

var ACCOUNT = CONFIG.account;
var KEYID = CONFIG.keyid;
var KEYFILE = path.join(__dirname, '..', 'var', CONFIG.keyfile);
var KEY = fs.readFileSync(KEYFILE, 'ascii');

var DOMAIN_EXT = CONFIG.domain.ext;
var DOMAIN_INT = CONFIG.domain.int;

var CLIENTS = null;

var HOST_CACHE_LOG = log.child({ component: 'host_cache' });
var HOST_CACHE = null;
var HOST_CACHE_TIMEOUT = null;
var HOST_CACHE_LOADING = false;
var HOST_CACHE_QUEUE = [];

/*
 * Common intervals expressed in milliseconds for use with setTimeout().
 */
var SECONDS = 1000;
var MINUTES = 60 * SECONDS;

function
hc_load_hosts(callback)
{
	var log = HOST_CACHE_LOG;

	if (HOST_CACHE !== null) {
		setImmediate(callback, null, HOST_CACHE);
		return;
	}

	HOST_CACHE_QUEUE.push(callback);

	if (HOST_CACHE_LOADING) {
		return;
	}
	HOST_CACHE_LOADING = true;

	list_all_machines(function (err, machines) {
		var cbq = HOST_CACHE_QUEUE;
		HOST_CACHE_QUEUE = [];
		HOST_CACHE_LOADING = false;

		if (err) {
			log.error(err, 'could not fetch machines');
			while (cbq.length > 0) {
				cbq.pop()(err);
			}
			return;
		}

		log.info('machine cache updated from JPC (%d entries)',
		    Object.keys(machines).length);

		HOST_CACHE = machines;
		HOST_CACHE_TIMEOUT = setTimeout(function () {
			hc_invalidate(true);
		}, 10 * MINUTES);

		while (cbq.length > 0) {
			cbq.pop()(null, HOST_CACHE);
		}
	});
}

function
hc_invalidate(by_timer)
{
	var log = HOST_CACHE_LOG;

	clearTimeout(HOST_CACHE_TIMEOUT);
	HOST_CACHE_TIMEOUT = null;

	if (HOST_CACHE !== null) {
		log.info('hosts cache invalidated by %s',
		    (by_timer ? 'timer' : 'force'));
		HOST_CACHE = null;
	}
}

/*
 * Load one machine, regardless of which data centre it resides in.  Update the
 * host cache with the result.
 */
function
load_one_machine(zone, callback)
{
	var res = null;

	mod_vasync.forEachParallel({ inputs: Object.keys(CLIENTS), func:
	    function (dc, done) {
		CLIENTS[dc].getMachine(zone, function (err, machine) {
			if (err) {
				if (err.name === 'ResourceNotFoundError') {
					done();
					return;
				}

				done(new VE(err, 'dc %s', dc));
				return;
			}

			if (machine) {
				if (res !== null) {
					done(new VE(err, 'machine %s found ' +
					    'in multiple DCs', zone));
					return;
				}

				res = machine;
			}

			done();
		});

	}}, function (err) {
		if (err) {
			/*
			 * If any requests failed, log the error.
			 */
			log.error(err, 'load machine %s');

			if (res === null) {
				/*
				 * We were unable to locate the server in
				 * any of the DCs that worked (if any), so
				 * pass the error on.
				 */
				callback(err);
				return;
			}
		}

		if (res === null) {
			callback(new VE('machine %s not found in any DC!',
			    zone));
			return;
		}

		if (HOST_CACHE !== null) {
			HOST_CACHE[res.id] = res;
		}

		callback(null, res);
	});
}

function
list_all_machines(callback)
{
	log.debug('listing all machines');

	if (CLIENTS === null) {
		setImmediate(callback, new VE('no clients yet'));
		return;
	}

	var res = {};

	mod_vasync.forEachParallel({ inputs: Object.keys(CLIENTS), func:
	    function (dc, done) {
		CLIENTS[dc].listMachines(function (err, machines) {
			if (err) {
				done(new VE(err, 'list machines %s', dc));
				return;
			}

			for (var i = 0; i < machines.length; i++) {
				var m = machines[i];

				if (res[m.id]) {
					done(new VE('machine %s found ' +
					    'in more than one DC'));
					return;
				}

				res[m.id] = m;
			}

			done();
		});

	}}, function (err) {
		if (err) {
			/*
			 * If any requests failed, log the error.
			 */
			log.error(err, 'list machines failure(s)');
		}

		/*
		 * Always return any machines we were able to get, even if
		 * at least one request returned an error.
		 */
		callback(err, res);
	});
}

function
get_pubkey_zone(zone, callback)
{
	/*
	 * Check the bulk host cache first.
	 */
	hc_load_hosts(function (err, machines) {
		if (err) {
			callback(err);
			return;
		}

		/*
		 * Check for this zone in the cache results.
		 */
		var m = machines[zone];
		if (m && m.id === zone && m.metadata && m.metadata.pubkey) {
			callback(null, m.metadata.pubkey);
			return;
		}

		log.info('cache miss for pubkey for zone %s', zone);

		/*
		 * Either we could not locate this zone, or it we were able to
		 * locate it but it did not have a public key yet.  Check the
		 * API directly.
		 */
		load_one_machine(zone, function (err, machine) {
			if (err) {
				callback(err);
				return;
			}

			if (!machine.metadata || !machine.metadata.pubkey) {
				callback(null, null);
				return;
			}

			callback(null, machine.metadata.pubkey);
		});
	});
}

function
get_pubkeys(callback)
{
	log.debug('listing all SSH public keys for machine auth');

	var res = [];

	hc_load_hosts(function (err, machines) {
		if (err) {
			callback(err);
			return;
		}

		machines.forEach(function (m) {
			if (!m.metadata || !m.metadata.pubkey) {
				return;
			}

			res.push({
				pk_id: m.id,
				pk_name: m.name,
				pk_fingerprint: m.metadata.pubkey
			});
		});

		callback(null, res);
	});
}

function
get_machine_by_ip(search_ip, callback)
{
	log.debug('checking for machine with IP %s', search_ip);

	hc_load_hosts(function (err, machines) {
		if (err) {
			callback(err);
			return;
		}

		var res = null;

		for (var i = 0; i < machines.length; i++) {
			var m = machines[i];

			if (m.ips.indexOf(search_ip) !== -1) {
				res = m;
				break;
			}
		}

		if (err) {
			/*
			 * If any requests failed, log the error.
			 */
			log.error(err, 'get_machine_by_ip failures');

			if (res === null) {
				/*
				 * If we did not find a result, return the
				 * error to the caller.  If we found a result
				 * then at least the DC in which this IP is
				 * present is working correctly.
				 */
				callback(err);
				return;
			}
		}

		if (res === null) {
			log.info('no machine with IP %s found', search_ip);
			callback(null, false);
			return;
		}

		log.info('found machine %s with IP %s', res.id, search_ip);
		callback(null, res);
	});
}

function
make_hosts(extra_hosts, callback)
{
	if (typeof (extra_hosts) === 'function') {
		callback = extra_hosts;
		extra_hosts = [];
	}

	var lines = [];
	var FMT = '%-16s %s';
	lines.push(sprintf(FMT, '127.0.0.1', 'localhost loghost'));
	lines.push(sprintf(FMT, '::1', 'localhost'));
	lines.push('');

	if (extra_hosts.length > 0) {
		extra_hosts.forEach(function (eh) {
			lines.push(sprintf(FMT, eh.ipaddr, eh.hostname));
		});
		lines.push('');
	}

	hc_load_hosts(function (err, machines) {
		if (err) {
			callback(err);
			return;
		}

		mod_jsprim.forEachKey(machines, function (id, m) {
			for (var j = 0; j < m.ips.length; j++) {
				var ip = m.ips[j];
				var internal = ip.match(/^10\./) ||
				    ip.match(/^192\.168\./);
				var hostname = internal ?
				    m.name + DOMAIN_INT :
				    m.name + DOMAIN_EXT + ' ' + m.name;
				lines.push(sprintf(FMT, ip, hostname));
			}
		});

		callback(null, lines);
	});
}

function
load_dc_list(callback)
{
	/*
	 * Create a bootstrap client, using the "default" data centre.
	 */
	var client = smartdc.createClient({
		sign: smartdc.privateKeySigner({
			key: KEY,
			keyId: KEYID,
			user: ACCOUNT
		}),
		user: ACCOUNT,
		url: 'https://us-west-1.api.joyentcloud.com'
	});

	var clients = {};

	client.listDatacenters(function (err, dclist) {
		if (err) {
			log.error(err, 'could not retrieve dclist (retrying)');
			setTimeout(function () {
				load_dc_list(callback);
			}, 5 * SECONDS);
			return;
		}

		mod_jsprim.forEachKey(dclist, function (dc, dcurl) {
			clients[dc] = smartdc.createClient({
				sign: smartdc.privateKeySigner({
					key: KEY,
					keyId: KEYID,
					user: ACCOUNT
				}),
				user: ACCOUNT,
				url: dcurl,
			});
		});
		log.info({ datacentres: dclist }, 'retrieved list of active ' +
		    'datacentres');

		CLIENTS = clients;

		setImmediate(callback);
	});
}



module.exports = {
	get_machine_by_ip: get_machine_by_ip,
	get_pubkeys: get_pubkeys,
	get_pubkey_zone: get_pubkey_zone,
	make_hosts: make_hosts,
	load_dc_list: load_dc_list,
};
