// server.js
// where your node app starts

// init project
var express = require('express');
var app     = express();
var fs      = require('fs');
var Twitter = require('twitter'),
    winston = require('winston'),
    config = {
        consumer_key: process.env.CONSUMER_KEY,
        consumer_secret: process.env.CONSUMER_SECRET,
        access_token: process.env.ACCESS_TOKEN,
        access_token_key: process.env.ACCESS_TOKEN,
        access_token_secret: process.env.ACCESS_TOKEN_SECRET
    },
    Rollbar = require("rollbar"),
    Repeat = require('repeat'),
    leftPad = require ('left-pad'),
    rollbar = new Rollbar(process.env.ROLLBAR_API_KEY),
    tweet   = new Twitter(config),
    video_path = '/tmp/nytimes.mp4',
    bucket = process.env.AWS_BUCKET_NAME,
    s3 = require('s3'),
    s3Client = s3.createClient({
      maxAsyncS3: 20,     // this is the default 
      s3RetryCount: 3,    // this is the default 
      s3RetryDelay: 1000, // this is the default 
      multipartUploadThreshold: 20971520, // this is the default (20 MB) 
      multipartUploadSize: 15728640, // this is the default (15 MB) 
      s3Options: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        // any other options are passed to new AWS.S3() 
        // See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Config.html#constructor-property 
      },
    }),
    s3Params = {
      localFile: "some/local/file",

      s3Params: {
        Bucket: bucket,
        Key: "some/remote/file",
        // other options supported by putObject, except Body and ContentLength. 
        // See: http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property 
      },
    },
    luxon = require('luxon'),
    DateTime = luxon.DateTime,
    dt = DateTime.local().setZone('America/New_York'),
    current_date = dt.toISODate();

require('winston-loggly-bulk');

winston.add(winston.transports.Loggly, {
  token: process.env.LOGGLY_TOKEN,
  subdomain: process.env.LOGGLY_SUBDOMAIN,
  tags: ["Winston-NodeJS", "nytimes"],
  json: true
});


const { exec } = require('child_process');

app.use(express.static('public'));

function initUpload () {
  var mediaType   = 'video/mp4'; // `'video/mp4'` is also supported
  var mediaSize   = require('fs').statSync(video_path).size;
  winston.log('info', `In initUpload. mediaSize: ${mediaSize}`)

  return makePost('media/upload', {
    command    : 'INIT',
    total_bytes: mediaSize,
    media_type : mediaType,
    media_category: 'tweet_video'
  }).then(data => data.media_id_string);
}

/**
 * Step 2 of 3: Append file chunk
 * @param String mediaId    Reference to media object being uploaded
 * @return Promise resolving to String mediaId (for chaining)
 */
function appendUpload (mediaId) {
  var mediaData   = require('fs').readFileSync(video_path);
  winston.log('info', "In appendUpload")
  return makePost('media/upload', {
    command      : 'APPEND',
    media_id     : mediaId,
    media        : mediaData,
    segment_index: 0
  }).then(data => mediaId);
}

/**
 * Step 3 of 3: Finalize upload
 * @param String mediaId   Reference to media
 * @return Promise resolving to mediaId (for chaining)
 */
function finalizeUpload (mediaId) {
  winston.log('info', `In finalizeUpload. mediaId: ${mediaId}`)

  return makePost('media/upload', {
    command : 'FINALIZE',
    media_id: mediaId,
  }).then(data => mediaId);
}

/**
 * (Utility function) Send a POST request to the Twitter API
 * @param String endpoint  e.g. 'statuses/upload'
 * @param Object params    Params object to send
 * @return Promise         Rejects if response is error
 */
function makePost (endpoint, params) {
  return new Promise((resolve, reject) => {
    tweet.post(endpoint, params, (error, data, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
}

function intervalsSinceMidnight() {
  let dt = DateTime.local().setZone('America/New_York');
  let start = dt.startOf('day');
  let diffInMinutes = dt.diff(start, 'minutes');
  //return (diffInMinutes.toObject().minutes)/10;
  return Math.round((diffInMinutes.toObject().minutes)/10);
}

function makeVideo() {
  var dt = DateTime.local().setZone('America/New_York');
  var  current_date = dt.toISODate();
    exec(`ffmpeg -y -start_number 1 -i https://s3.amazonaws.com/${bucket}/${current_date}/image_%03d.png -c:v libx264 -r 2 -pix_fmt yuv420p /tmp/nytimes.mp4`, {cwd: "/tmp"}, (err, stdout, stderr) => {
    if (err) {
      rollbar.log(err);
      return;
    }

    winston.log('info', `mp4 rendering complete. ffmpeg output ${stdout}`);

    winston.log('info', `Finished converting file. Uploading to S3.`);

    var uploader = s3Client.uploadFile({
      localFile: "/tmp/nytimes.mp4",

      s3Params: {
        Bucket: bucket,
        Key: `${current_date}/nytimes.mp4`,
        ACL: 'public-read',
        ContentType: 'video/mp4'
      }
    });

    uploader.on('error', function(err) {
      rollbar.log(err)
    });

    uploader.on('end', function() {
      console.log("done uploading");
      winston.log('info', `Successfully uploaded to bucket ${bucket}`);

      return true;
    });


    initUpload() // Declare that you wish to upload some media
      .then(appendUpload) // Send the data for the media
      .then(finalizeUpload) // Declare that you are done uploading chunks
      .then(mediaId => {

        var upload_status = "pending";
        Repeat(function() {
          console.log("checking media status");
          tweet.get('media/upload', {
            command : 'STATUS',
            media_id: mediaId,
          }, function(error, response) {
            if (error) {
              rollbar.log(error);
            } else {
              upload_status = response.processing_info.state;
              winston.log('info', `Upload Status: ${upload_status}`)
            }
          });
        }).while(function() {
          return (upload_status != "succeeded" && upload_status != "failed");
        }).every(5, "secs")
          .for(30, 'secs')
          .start.now()
          .then(function() {
            var status = {
              status: '',
              media_ids: mediaId // Pass the media id string
            }

            winston.log('info', `Tweeting mediaId ${mediaId}`);
            tweet.post('statuses/update', status, function(error, tweet_data, response) {
              if (!error) {
                winston.log('info', tweet_data);

              } else {
                rollbar.log(error);
              }
            });
          })
      })       
      .catch(error => { rollbar.log('caught in initUpload', error); });

  });
 
}

// http://expressjs.com/en/starter/basic-routing.html
app.get("/", function (request, response) {
  response.sendFile(__dirname + '/views/index.html');
  console.log(intervalsSinceMidnight());
});

app.get("/tweet", function(request, response) {
  makeVideo();
  response.sendStatus(200);
});

app.get("/snapshot", function(request, response) {
  var dt = DateTime.local().setZone('America/New_York');
  var  current_date = dt.toISODate();

  winston.log('info', `Rendering frames via command: phantomjs render_frames.js`);
  exec(`phantomjs /app/render_frames.js`, {cwd: "/tmp"}, (err, stdout, stderr) => {
    if (err) {
      rollbar.log(err);
      return;
    } else {

      exec(`composite -pointsize 18 label:"${dt.toLocaleString(DateTime.DATETIME_SHORT_WITH_SECONDS)}" -geometry +25+10 -gravity northeast /tmp/frame.png /tmp/frame_stamped.png`, {cwd: "/tmp"}, (err, stdout, stderr) => {
        
        if (err) {
          rollbar.log(err);
          return;
        } else {
        
          winston.log('info', `Finished timestamping file.`);

          var uploader = s3Client.uploadFile({
            localFile: "/tmp/frame_stamped.png",

            s3Params: {
              Bucket: bucket,
              Key: `${current_date}/image_${leftPad(intervalsSinceMidnight(), 3, 0)}.png`,
              ACL: 'public-read'
            }
          });

          uploader.on('error', function(err) {
            rollbar.log(err)
          });

          uploader.on('end', function() {
            console.log("done uploading");
            winston.log('info', `Successfully uploaded to bucket ${bucket}`);

            return true;
          });
        }
      });
      console.log("Finished");
      response.sendStatus(200);
    }
  });
});

// listen for requests :)
var listener = app.listen(process.env.PORT, function () {
  console.log('Your app is listening on port ' + listener.address().port);
});
