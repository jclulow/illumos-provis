
var path = require('path');
var GitHubApi = require("github");
var CONFIG = require(path.join(process.env.HOME, '.github.json'));

var github = new GitHubApi({ version: "3.0.0" });

github.authenticate({
  type: 'oauth',
  token: CONFIG.token
});

function addKey(uuid, ssh_key, callback)
{
  github.repos.createKey({
    user: CONFIG.user,
    repo: CONFIG.repo,
    title: uuid,
    key: ssh_key
  }, function(err, res) {
    return callback(err, res);
  });
}

module.exports = {
  addKey: addKey
};
