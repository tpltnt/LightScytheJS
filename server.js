
var fs = require('fs');
var path = require("path");
var express = require('express');
var sockjs = require('sockjs');
var microtime = require('microtime');
var nanotimer = require('nanotimer');
var pngparse = require("pngparse");
var gm = require("gm");
require ("gm-buffer");

var imgDir = __dirname + '/img';
var spiDevice = '/dev/spidev0.0';
var numLEDs = 32; 
var bytePerPixel = 3; //RGB

var rowResetTime = 1000; // number of us CLK has to be pulled low (=no writes) for frame reset
         // manual of WS2801 says 500 is enough, however we need at least 1000

var rowDelay = 10000; //in ns - 100 FPS

var rowsDropped = 0; //count dropped Frames

var app = express();


var myImage = {
  filename : path.join(imgDir, "rainbowsparkle.png"),
  size : {
    width : 1,
    hight : 1
  },
  ratio : 1.0, //width:height ratio of image
  imgBuffer : null
};


var blackBuffer = new Buffer(numLEDs*bytePerPixel);
for (var i=0; i<blackBuffer.length; i++){
  blackBuffer[i]=0;
};

// log requests
app.use(express.logger('dev'));

app.use(express.static(__dirname + '/static'));

app.use(app.router);

var server = app.listen(3000);
console.log('lisitening on 3000');


/*
 * websockets setup
 */

var ws = sockjs.createServer();

var myWsConn = null;

function wsSend(o) {
  if (myWsConn!==null) {
    try {
      myWsConn.write(JSON.stringify(o));
    } catch (e) {
        console.error("Error sending to client:", e);
    }
  }
} // end wsSend


ws.on('connection', function(conn) {

    myWsConn = conn;
    if (imageList!==null)
        wsSend({'updateImgList' : Object.keys(imageList)});


    conn.on('data', function(message) {
        var o;
        // parsing message from client
		try {
	    	o = JSON.parse(message);
		} catch (e) {
	    	console.error("Invalid JSON on SockJS:", message);
		}
		if (!o)
			return;
		if (o.go) {
      		console.log("Go for gold!");
      		if (myImage.imgBuffer !== null){
        		writeFrame(myImage.imgBuffer,'10m',function(result){
          			var message =  result.rows+" rows in "+result.frametime+" us = "+result.rowsPerSecond+" rows/s  with "+result.framesDropped+" dropped frames";
          			console.log(message);
          			wsSend({'logmessage':message});
          			wsSend({'imageBufferReady':true});
        		});
      		} // end if imgBuffer !== null
		} else if (o.imageSelected){
      		setMyImage(o.imageSelected);
    	}
    }); // end conn.on('data')

    conn.on('close', function() {
      myWsConn = null;
      console.log('Client closed connection.');
    });
});

ws.installHandlers(server, {prefix:'/sockjs'});

var imageList = null;

function parseImageDir(){
  // http://nodeexamples.com/2012/09/28/getting-a-directory-listing-using-the-fs-module-in-node-js/
  fs.readdir(imgDir, function (err, filenames) {
      if (err) {
          throw err;
      }
    imageList = new Array();  
    filenames.filter(function(filename){
       var regEx = /.*.\.(jpg|jpeg|png)$/i;
       return (regEx.test(filename) && fs.statSync(path.join(imgDir, filename)).isFile());
    }).forEach(function (filename) {
      imageList[filename] = {'aspectRatio' : null};
    });
    console.log(imageList);
    console.log(Object.keys(imageList));
    wsSend({'updateImgList' : Object.keys(imageList)});
  });
}

parseImageDir();

function setMyImage(imagename, callback){
  myImage.filename = path.join(imgDir, imagename);
  gm(myImage.filename).size(function (err, size) {
    if (err) {
      console.log ("Error reading image " + myImage.filename);
      throw err;
    } else {
      //console.log(size);
      //console.log(myImage);
      myImage.size = size;
      myImage.ratio = myImage.size.width / myImage.size.height;
      myImage.buffer = null;
      var imageParms = { 
        widthInMeters : myImage.ratio * 1, // LightScyte is 1m high currently  ToDo: parametrize this
      };
      wsSend({ 'imageSet' : {
        'imageParms' : imageParms
        }
      });
     prepareImageBuffer(function(){
     	if (callback)
			callback();
     });
    } //end else if err
  });
}


var fd = fs.openSync(spiDevice, 'w');
var isBusy = false;

var lastWriteTime = microtime.now()-rowResetTime-1;

function isReady(){
  return microtime.now() > (lastWriteTime + rowResetTime);
}

/*
 * write a row with RGB values to the strip
 */

function writeRow(row, buffer){
  if (isReady()){
    fs.writeSync(fd, buffer, row*numLEDs*bytePerPixel, numLEDs*bytePerPixel, null);
    lastWriteTime = microtime.now();
    return true;
  }
  console.log('LED strip not ready, frame dropped: '+row);
  return false;
}


function writeFrame(buffer,frameDelay, callback){
  var row = 0;
  var framesDropped = 0;
  var rows = buffer.length/(numLEDs*bytePerPixel);
  var myTimer = new nanotimer();
  var tstart = microtime.now();
  myTimer.setInterval(function(){
    if (row>=rows){
      myTimer.clearInterval();
      var frametime = microtime.now()-tstart;

      if (callback)
	      callback({'frametime'     : frametime,
	                'rows'          : rows,
	                'rowsPerSecond' : Math.round(rows*100000000/frametime,2)/100,
	                'framesDropped' : framesDropped
	      });
//      result.frametime = microtime.now()-tstart;
//      result.rows = rows;
//      console.log(row+" rows in "+timeneeded+" us = "+(row*1000000/timeneeded)+" rows/s  with "+framesDropped+" dropped frames");
    } else {
      //console.log("write row "+row);
      framesDropped += !writeRow(row,buffer);
      row++;
    }
    }, frameDelay, function(err) {
      if(err) {
         //error
      }
  });
} //end writeFrame




/* PARSE DIRECTLY FROM resized and aligned png file
pngparse.parseFile(myImage.filename, function(err, data) {
  if(err)
    throw err
  console.log(data); 
  myImage.imgBuffer = Buffer.concat([data.data, blackBuffer]);
  //append 1 black row


  writeFrame(myImage.imgBuffer,'10m',function(result){
    console.log(result.rows+" rows in "+result.frametime+" us = "+result.rowsPerSecond+" rows/s  with "+result.framesDropped+" dropped frames");
  });
});
*/

function prepareImageBuffer(callback){
gm(myImage.filename)
  .resize(Math.round(100*myImage.ratio),numLEDs,"!")
  .rotate('black',90)
  .setFormat('PNG')
  .buffer(function(err, buf) {
     pngparse.parse(buf, function(err, data) {
       if(err) {
         wsSend({'logmessage' : "error processing image"});
         throw err
       } else {
         myImage.imgBuffer = Buffer.concat([data.data, blackBuffer]);
         wsSend({'logmessage' : "image buffer ready"});
         wsSend({'imageBufferReady':true});
         if (callback)
     	 	callback();
       }       
     });
   });
};

/* 
 * STARTUP ANIMATION
 */

 setMyImage("rainbowsparkle.png", function(){
	writeFrame(myImage.imgBuffer,'8m');
 });

