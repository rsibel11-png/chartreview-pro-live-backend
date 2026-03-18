var fs = require('fs');
var files = ['patients', 'documents', 'summaries'];
files.forEach(function(f) {
  var p = 'src/handlers/' + f + '.js';
  var c = fs.readFileSync(p, 'utf8');
  // Replace the markdown hyperlink corruption: [err.me](https://err.me)ssage -> err.message
  var open_bracket = String.fromCharCode(91);
  var close_bracket = String.fromCharCode(93);
  var open_paren = String.fromCharCode(40);
  var close_paren = String.fromCharCode(41);
  var broken = open_bracket + 'err.me' + close_bracket + open_paren + 'https://err.me' + close_paren + 'ssage';
  var fixed_val = 'err' + '.' + 'message';
  while (c.indexOf(broken) !== -1) {
    c = c.replace(broken, fixed_val);
  }
  fs.writeFileSync(p, c, 'utf8');
  console.log(f + ': ' + (c.indexOf(broken) === -1 ? 'FIXED' : 'STILL BROKEN'));
});
