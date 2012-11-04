var CHARS = [];
function cc(a) { return a.charCodeAt(0); }
function chr(a) { return String.fromCharCode(a); }
for (var c = cc('A'); c <= cc('Z'); c++) { CHARS.push(chr(c)); }
for (var c = cc('a'); c <= cc('z'); c++) { CHARS.push(chr(c)); }
for (var c = cc('0'); c <= cc('9'); c++) { CHARS.push(chr(c)); }

function rndpass(len)
{
  var password = '';
  for (var j = 0; j < len; j++) {
    var code = Math.floor(Math.random() * CHARS.length);
    password += CHARS[code];
  }
  return password;
}

module.exports = rndpass;
