/* globals phantom */
var system = require('system');
var page = require('webpage').create();

page.viewportSize = { width: 1024, height: 600 };
page.settings.javascriptEnabled = false;

page.clipRect = {
  top: 0,
  left: 0,
  width: 1024,
  height: 800
};

phantom.onError = function(msg, trace) {
  var msgStack = ['PHANTOM ERROR: ' + msg];
  if (trace && trace.length) {
    msgStack.push('TRACE:');
    trace.forEach(function(t) {
      msgStack.push(' -> ' + (t.file || t.sourceURL) + ': ' + t.line + (t.function ? ' (in function ' + t.function +')' : ''));
    });
  }
  console.error(msgStack.join('\n'));
  phantom.exit(1);
};

page.onConsoleMessage = function(msg, lineNum, sourceId) {
  console.log('CONSOLE: ' + msg + ' (from line #' + lineNum + ' in "' + sourceId + '")');
};

page.onError = function(msg, trace) {

  var msgStack = ['ERROR: ' + msg];

  if (trace && trace.length) {
    msgStack.push('TRACE:');
    trace.forEach(function(t) {
      msgStack.push(' -> ' + t.file + ': ' + t.line + (t.function ? ' (in function "' + t.function +'")' : ''));
    });
  }

  console.error(msgStack.join('\n'));

};

page.open('https://nytimes.com', function (status) {
  console.log(status);
  if (status == "success") {
    console.log("SUCCESS");
    
    // Add an interval every 25th second
    page.render('/tmp/frame.png', { format: "png" });
    phantom.exit();
  }
});

// ffmpeg -start_number 1 -i /tmp/frames/frame%04d.png -c:v libx264 -r 25 -pix_fmt yuv420p /tmp/trump_out.mp4
