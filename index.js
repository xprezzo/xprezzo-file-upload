/*!
 * xprezzo-multipart-form
 * Copyright(c) 2020 Ben Ajenoui <info@seohero.io>
 * MIT Licensed
 */

'use strict'

var createError = require('xprezzo-http-errors')
var uid = require('uid-safe')
var stream = require('stream');
var util = require('util');
var fs = require('fs');
var path = require('path');
var os = require('os');
var debugEvent = require("xprezzo-debug")("xprezzo:multipart:event");
var Buffer = require('xprezzo-buffer').Buffer
var StringDecoder = require('string_decoder').StringDecoder;

var PARSE = {
  START : 0,
  START_BOUNDARY : 1,
  HEADER_FIELD_START : 2,
  HEADER_FIELD : 3,
  HEADER_VALUE_START : 4,
  HEADER_VALUE : 5,
  HEADER_VALUE_ALMOST_DONE : 6,
  HEADERS_ALMOST_DONE : 7,
  PART_DATA_START : 8,
  PART_DATA : 9,
  CLOSE_BOUNDARY : 10,
  END : 11
};

var CHAR = {
  LF : 10,
  CR : 13,
  SPACE : 32,
  HYPHEN : 45,
  COLON : 58,
  A : 97,
  Z : 122
};

var CONTENT_TYPE_RE = /^multipart\/(?:form-data|related)(?:;|$)/i;
var CONTENT_TYPE_PARAM_RE = /;\s*([^=]+)=(?:"([^"]+)"|([^;]+))/gi;
var FILE_EXT_RE = /(\.[_\-a-zA-Z0-9]{0,16})[\S\s]*/;
var LAST_BOUNDARY_SUFFIX_LEN = 4; // --\r\n

exports.Form = Form;

util.inherits(Form, stream.Writable);

function Form(options) {
  var opts = options || {};
  stream.Writable.call(this, { emitClose: false });
  this.autoFields = !!opts.autoFields;
  this.autoFiles = !!opts.autoFiles;
  this.backpressure = false;
  this.bytesReceived = 0;
  this.bytesExpected = null;
  this.emitQueue = [];
  this.encoding = opts.encoding || 'utf8';
  this.error = null;
  this.flushing = 0;
  this.maxFields = opts.maxFields || 1000;
  this.maxFieldsSize = opts.maxFieldsSize || 2 * 1024 * 1024;
  this.maxFilesSize = opts.maxFilesSize || Infinity;
  this.openedFiles = [];
  this.totalFieldSize = 0;
  this.totalFieldCount = 0;
  this.totalFileSize = 0;
  this.uploadDir = opts.uploadDir || os.tmpdir();
  this.writeCbs = [];
  var self = this;
  this.on('newListener', function(eventName) {
    if (eventName === 'file') {
      self.autoFiles = true;
    } else if (eventName === 'field') {
      self.autoFields = true;
    }
  });
}
// wait for request to end before calling callBack
Form.prototype.terminate = function (done) {
  if (this.called) return;
  debugEvent("Event: Terminated");
  this.called = true;
  // wait for req events to fire
  var self=this;
  process.nextTick(function() {
    if (self.waitend && self.req.readable) {
      // dump rest of request
      self.req.resume();
      self.req.once('end', done);
      return;
    }
    if(typeof done === "function"){
      done();
    } else {
      debugEvent("CallBack: "+ done);
    }
  });
};

Form.prototype.clearPartVars=function (){
  this.partHeaders = {};
  this.partName = null;
  this.partFilename = null;
  this.partTransferEncoding = 'binary';
  this.destStream = null;
  this.headerFieldDecoder = new StringDecoder(this.encoding);
  this.headerField = ''
  this.headerValueDecoder = new StringDecoder(this.encoding);
  this.headerValue = ''
}

Form.prototype.cleanupOpenFiles=function () {
  var self=this;
  debugEvent("Event: Clean Up Open Files");
  this.openedFiles.forEach(function(internalFile) {
    // since fd slicer autoClose is true, destroying the only write stream
    // is guaranteed by the API to close the fd
    internalFile.ws.destroy();
    fs.unlink(internalFile.publicFile.path, function(err) {
      if (err) self.handleError(err);
    });
  });
  this.openedFiles = [];
}
Form.prototype.errorEventQueue=function ( eventEmitter, err) {
  var items = this.emitQueue.filter(function (item) {
    return item.ee === eventEmitter;
  });
  if (items.length === 0) {
    eventEmitter.emit('error', err);
    return;
  }
  items.forEach(function (item) {
    item.err = err;
  });
}
Form.prototype.setRequestEvents =function(){
  var self=this;
  var onReqEnd=function() {
    self.waitend = false;
  };
  var onClosed=function  () {
    self.req.removeListener('aborted', onReqAborted)
  };
  var onReqAborted=function () {
    self.waitend = false;
    self.emit('aborted');
    handleError(new Error('Request aborted'))
  }
  var handleError=function (err) {
    debugEvent("Event: handleError");
    var first = !self.error;
    if (first) {
      self.error = err;
      self.req.removeListener('aborted', onReqAborted);
      self.req.removeListener('end', onReqEnd);
      if (self.destStream) {
        self.errorEventQueue(self.destStream, err);
      }
    }
    self.cleanupOpenFiles();
    if (first) {
      self.emit('error', err);
    }
  }
  this.req.on('error', function(err) {
    self.waitend = false;
    handleError(err);
  });
  this.req.on('end', onReqEnd);
  this.req.on('aborted', onReqAborted);
  this.handleError = handleError;
  this.on('close', onClosed);
}

Form.prototype.validationError=function (err) {
  var self=this;
  // handle error on next tick for event listeners to attach
  process.nextTick(self.handleError.bind(null, err));
  return;
}
Form.prototype.setCallBackEvent=function(callBack){
  this.autoFields = true;
  this.autoFiles = true;
  var fields = {};
  var files = {};
  var self=this;
  this.on('error', function(err) {
    self.terminate(function() {
      callBack(err);
    });
  });
  this.on('field', function(name, value) {
    var fieldsArray = fields[name] || (fields[name] = []);
    fieldsArray.push(value);
  });
  this.on('file', function(name, file) {
    var filesArray = files[name] || (files[name] = []);
    filesArray.push(file);
  });
  this.on('close', function() {
    self.terminate(function() {
      callBack(null, fields, files);
    });
  });
}
Form.prototype.holdEmitQueue=function (eventEmitter) {
  var item = { cb: null, ee: eventEmitter, err: null }
  this.emitQueue.push(item);
  var self=this;
  return function(callBack) {
    item.cb = callBack;
    flushEmitQueue(self);
  };
};
Form.prototype.maybeClose=function() {
  var self=this;
  if (this.flushing > 0 || this.error) return;
  debugEvent("Event: maybeClose");
  // go through the emit queue in case any field, file, or part events are
  // waiting to be emitted
  this.holdEmitQueue()(function() {
    // nextTick because the user is listening to part 'end' events and we are
    // using part 'end' events to decide when to emit 'close'. we add our 'end'
    // handler before the user gets a chance to add theirs. So we make sure
    // their 'end' event fires before we emit the 'close' event.
    // this is covered by test/standalone/test-issue-36
    process.nextTick(function() {
      self.emit('close');
    });
  });
};
Form.prototype.beginFlush=function (self) {
  this.flushing += 1;
};
Form.prototype.endFlush=function () {
  this.flushing -= 1;
  if (this.flushing < 0) {
    // if this happens this is a critical bug in multiparty and this stack trace
    // will help us figure it out.
    this.handleError(new Error('unexpected endFlush'))
    return;
  }
  this.maybeClose();
}

Form.prototype.flushWriteCbs=function () {
  debugEvent("Event: Flush write callback");
  this.writeCbs.forEach(function(cb) {
    process.nextTick(cb);
  });
  this.writeCbs = [];
  this.backpressure = false;
}

Form.prototype.setBoundary = function(boundary){
  this.boundary = Buffer.alloc(boundary.length + 4)
  this.boundary.write('\r\n--', 0, boundary.length + 4, 'ascii');
  this.boundary.write(boundary, 4, boundary.length, 'ascii');
  this.lookbehind = Buffer.alloc(this.boundary.length + 8)
  this.state = PARSE.START;
  this.boundaryChars = {};
  for (var i = 0; i < this.boundary.length; i++) {
    this.boundaryChars[this.boundary[i]]  = true;
  }
  this.index = null;
  this.partBoundaryFlag = false;
  var self=this;
  this.beginFlush();
  this.on('finish', function() {
    if (self.state !== PARSE.END) {
      self.handleError(createError(400, 'stream ended unexpectedly'));
    }
    self.endFlush();
  });
}

Form.prototype.parse = function(req, callBack) {
  debugEvent("Event: Parse Start");
  this.called = false;
  this.waitend = true;
  this.req = req;
  var self = this;
  this.setRequestEvents();
  if (typeof callBack==="function") {
    // if the user supplies a callback, this implies autoFields and autoFiles
    this.setCallBackEvent(callBack);
  }
  this.bytesExpected = getBytesExpected(req.headers);
  var state = req._readableState;
  if (req._decoder || (state && (state.encoding || state.decoder))) {
    // this is a binary protocol
    // if an encoding is set, input is likely corrupted
    return this.validationError(new Error('request encoding must not be set'));
  }
  var contentType = req.headers['content-type'];
  if (!contentType) {
    return this.validationError(createError(415, 'missing content-type header'));
  }
  var m = CONTENT_TYPE_RE.exec(contentType);
  if (!m) {
    return this.validationError(createError(415, 'unsupported content-type'));
  }
  var boundary;
  CONTENT_TYPE_PARAM_RE.lastIndex = m.index + m[0].length - 1;
  while ((m = CONTENT_TYPE_PARAM_RE.exec(contentType))) {
    if (m[1].toLowerCase() !== 'boundary') continue;
    boundary = m[2] || m[3];
    break;
  }
  if (!boundary) {
    return this.validationError(createError(400, 'content-type missing boundary'));
  }
  this.setBoundary( boundary);
  req.pipe(this);
};

Form.prototype.parseStart=function(){
  this.index = 0;
  this.state = PARSE.START_BOUNDARY;
}

Form.prototype.parseStartBoundary=function(c){
  var boundaryLength = this.boundary.length;
  if (this.index === boundaryLength - 2 && c === CHAR.HYPHEN) {
    this.index = 1;
    this.state = PARSE.CLOSE_BOUNDARY;
  } else if (this.index === boundaryLength - 2) {
    if (c !== CHAR.CR) return this.handleError(createError(400, 'Expected CR Received ' + c));
    this.index++;
  } else if (this.index === boundaryLength - 1) {
    if (c !== CHAR.LF) return this.handleError(createError(400, 'Expected LF Received ' + c));
    this.index = 0;
    this.onParsePartBegin();
    this.state = PARSE.HEADER_FIELD_START;
  } else {
    if (c !== this.boundary[this.index+2]) this.index = -2;
    if (c === this.boundary[this.index+2]) this.index++;
  }
};
Form.prototype.parseHeaderFieldStart=function(i){
  this.state = PARSE.HEADER_FIELD;
  this.headerFieldMark = i;
  this.index = 0;
};
Form.prototype.parseHeaderField=function(buffer, c, i){
  if (c === CHAR.CR) {
    this.headerFieldMark = null;
    this.state = PARSE.HEADERS_ALMOST_DONE;
  } else {
    this.index++;
    if (c === CHAR.HYPHEN) {
      // do nothing
    } else if (c === CHAR.COLON) {
      if (this.index === 1) {
        // empty header field
        this.handleError(createError(400, 'Empty header field'));
        return true;
      }
      this.onParseHeaderField(buffer.slice(this.headerFieldMark, i));
      this.headerFieldMark = null;
      this.state = PARSE.HEADER_VALUE_START;
    } else {
      var cl = lower(c);
      if (cl < CHAR.A || cl > CHAR.Z) {
        this.handleError(createError(400, 'Expected alphabetic character, received ' + c));
        return true;
      }
    }
  }
  return false;
};
Form.prototype.parseValueStart=function(c, i){
  if (c === CHAR.SPACE) return true;
  this.headerValueMark = i;
  this.state = PARSE.HEADER_VALUE;
  return false;
};
Form.prototype.parseValue=function(buffer, c, i){
  if (c === CHAR.CR) {
    this.onParseHeaderValue(buffer.slice(this.headerValueMark, i));
    this.headerValueMark = null;
    this.onParseHeaderEnd();
    this.state = PARSE.HEADER_VALUE_ALMOST_DONE;
  }
};
Form.prototype.parseData=function(buffer, c, i){
  var boundaryLength = this.boundary.length;
  var boundaryEnd = boundaryLength - 1;
  var bufferLength = buffer.length;
  this.prevIndex = this.index;
  if (this.index === 0) {
    // boyer-moore derrived algorithm to safely skip non-boundary data
    i += boundaryEnd;
    while (i < bufferLength && !(buffer[i] in this.boundaryChars)) {
      i += boundaryLength;
    }
    i -= boundaryEnd;
    c = buffer[i];
  }
  if (this.index < boundaryLength) {
    if (this.boundary[this.index] === c) {
      if (this.index === 0) {
        this.onParsePartData(buffer.slice(this.partDataMark, i));
        this.partDataMark = null;
      }
      this.index++;
    } else {
      this.index = 0;
    }
  } else if (this.index === boundaryLength) {
    this.index++;
    if (c === CHAR.CR) {
      // CHAR.CR = part boundary
      this.partBoundaryFlag = true;
    } else if (c === CHAR.HYPHEN) {
      this.index = 1;
      this.state = PARSE.CLOSE_BOUNDARY;
      return i;
    } else {
      this.index = 0;
    }
  } else if (this.index - 1 === boundaryLength) {
    if (this.partBoundaryFlag) {
      this.index = 0;
      if (c === CHAR.LF) {
        this.partBoundaryFlag = false;
        this.onParsePartEnd();
        this.onParsePartBegin();
        this.state = PARSE.HEADER_FIELD_START;
        return i;
      }
    } else {
      this.index = 0;
    }
  }

  if (this.index > 0) {
    // when matching a possible boundary, keep a lookbehind reference
    // in case it turns out to be a false lead
    this.lookbehind[this.index-1] = c;
  } else if (this.prevIndex > 0) {
    // if our boundary turned out to be rubbish, the captured lookbehind
    // belongs to partData
    this.onParsePartData(this.lookbehind.slice(0, this.prevIndex));
    this.prevIndex = 0;
    this.partDataMark = i;

    // reconsider the current character even so it interrupted the sequence
    // it could be the beginning of a new sequence
    i--;
  }
  return i;
}

Form.prototype._write = function(buffer, encoding, callBack) {
  if (this.error) return;
  this.prevIndex = this.index;
  for (var i = 0; i < buffer.length; i++) {
    var c = buffer[i];
    switch (this.state) {
      case PARSE.START:
        this.parseStart();
        /* falls through */
      case PARSE.START_BOUNDARY:
        this.parseStartBoundary(c);
        break;
      case PARSE.HEADER_FIELD_START:
        this.parseHeaderFieldStart(i);
        /* falls through */
      case PARSE.HEADER_FIELD:
        if(this.parseHeaderField(buffer, c, i)){
          return;
        }
        break;
      case PARSE.HEADER_VALUE_START:
        if(this.parseValueStart(c, i)){
          break;
        }
        /* falls through */
      case PARSE.HEADER_VALUE:
        this.parseValue(buffer, c, i);
        break;
      case PARSE.HEADER_VALUE_ALMOST_DONE:
        if (c !== CHAR.LF) return this.handleError(createError(400, 'Expected LF Received ' + c));
        this.state = PARSE.HEADER_FIELD_START;
        break;
      case PARSE.HEADERS_ALMOST_DONE:
        if (c !== CHAR.LF) return this.handleError(createError(400, 'Expected LF Received ' + c));
        var err = this.onParseHeadersEnd(i + 1);
        if (err) return this.handleError(err);
        this.state = PARSE.PART_DATA_START;
        break;
      case PARSE.PART_DATA_START:
        this.state = PARSE.PART_DATA;
        this.partDataMark = i;
        /* falls through */
      case PARSE.PART_DATA:
        i = this.parseData(buffer, c, i);
        break;
      case PARSE.CLOSE_BOUNDARY:
        if (c !== CHAR.HYPHEN) return this.handleError(createError(400, 'Expected HYPHEN Received ' + c));
        if (this.index === 1) {
          this.onParsePartEnd();
          this.state = PARSE.END;
        } else if (this.index > 1) {
          return this.handleError(new Error('Parser has invalid state.'))
        }
        this.index++;
        break;
      case PARSE.END:
        break;
      default:
        this.handleError(new Error('Parser has invalid state.'))
        return;
    }
  }
  if (this.headerFieldMark != null) {
    this.onParseHeaderField(buffer.slice(this.headerFieldMark));
    this.headerFieldMark = 0;
  }
  if (this.headerValueMark != null) {
    this.onParseHeaderValue(buffer.slice(this.headerValueMark));
    this.headerValueMark = 0;
  }
  if (this.partDataMark != null) {
    this.onParsePartData(buffer.slice(this.partDataMark));
    this.partDataMark = 0;
  }
  this.bytesReceived += buffer.length;
  this.emit('progress', this.bytesReceived, this.bytesExpected);
  if(typeof callBack==="function"){
    if (this.backpressure) {
      this.writeCbs.push(callBack);
    } else {
        callBack();
    }
  }
};

Form.prototype.onParsePartBegin = function() {
  this.clearPartVars();
}

Form.prototype.onParseHeaderField = function(b) {
  this.headerField += this.headerFieldDecoder.write(b);
}

Form.prototype.onParseHeaderValue = function(b) {
  this.headerValue += this.headerValueDecoder.write(b);
}

Form.prototype.onParseHeaderEnd = function() {
  this.headerField = this.headerField.toLowerCase();
  this.partHeaders[this.headerField] = this.headerValue;

  var m;
  if (this.headerField === 'content-disposition') {
    if (m = this.headerValue.match(/\bname="([^"]+)"/i)) {
      this.partName = m[1];
    }
    this.partFilename = parseFilename(this.headerValue);
  } else if (this.headerField === 'content-transfer-encoding') {
    this.partTransferEncoding = this.headerValue.toLowerCase();
  }

  this.headerFieldDecoder = new StringDecoder(this.encoding);
  this.headerField = '';
  this.headerValueDecoder = new StringDecoder(this.encoding);
  this.headerValue = '';
}

Form.prototype.onParsePartData = function(b) {
  if (this.partTransferEncoding === 'base64') {
    this.backpressure = ! this.destStream.write(b.toString('ascii'), 'base64');
  } else {
    this.backpressure = ! this.destStream.write(b);
  }
}

Form.prototype.onParsePartEnd = function() {
  if (this.destStream) {
    this.flushWriteCbs();
    var s = this.destStream;
    process.nextTick(function() {
      s.end();
    });
  }
  this.clearPartVars();
}

Form.prototype.onParseHeadersEnd = function(offset) {
  switch(this.partTransferEncoding){
    case 'binary':
    case '7bit':
    case '8bit':
      this.partTransferEncoding = 'binary';
      break;
    case 'base64': break;
    default:
      return createError(400, 'unknown transfer-encoding: ' + this.partTransferEncoding);
  }
  this.totalFieldCount += 1;
  if (this.totalFieldCount > this.maxFields) {
    return createError(413, 'maxFields ' + this.maxFields + ' exceeded.');
  }
  this.destStream = new stream.PassThrough();
  this.destStream.headers = this.partHeaders;
  this.destStream.name = this.partName;
  this.destStream.filename = this.partFilename;
  this.destStream.byteOffset = this.bytesReceived + offset;
  var partContentLength = this.destStream.headers['content-length'];
  this.destStream.byteCount = partContentLength ? parseInt(partContentLength, 10) :
    this.bytesExpected ? (this.bytesExpected - this.destStream.byteOffset -
      this.boundary.length - LAST_BOUNDARY_SUFFIX_LEN) :
      undefined;
  if (this.destStream.filename == null && this.autoFields) {
    this.handleField( this.destStream);
  } else if (this.destStream.filename != null && this.autoFiles) {
    this.handleFile(this.destStream);
  } else {
    this.handlePart( this.destStream);
  }
  var self = this;
  this.destStream.on('drain', function() {
    self.flushWriteCbs();
  });
}

util.inherits(LimitStream, stream.Transform)
function LimitStream (limit) {
  stream.Transform.call(this)

  this.bytes = 0
  this.limit = limit
}

LimitStream.prototype._transform = function _transform (chunk, encoding, callback) {
  var length = !Buffer.isBuffer(chunk)
    ? Buffer.byteLength(chunk, encoding)
    : chunk.length

  this.bytes += length

  if (this.bytes > this.limit) {
    var err = new Error('maximum file length exceeded')
    err.code = 'ETOOBIG'
    callback(err)
  } else {
    this.push(chunk)
    this.emit('progress', this.bytes, length)
    callback()
  }
}

function getBytesExpected(headers) {
  var contentLength = headers['content-length'];
  if (contentLength) {
    return parseInt(contentLength, 10);
  } else if (headers['transfer-encoding'] == null) {
    return 0;
  } else {
    return null;
  }
}

function flushEmitQueue(self) {
  while (self.emitQueue.length > 0 && self.emitQueue[0].cb) {
    var item = self.emitQueue.shift();

    // invoke the callback
    item.cb();

    if (item.err) {
      // emit the delayed error
      item.ee.emit('error', item.err);
    }
  }
}

Form.prototype.handlePart=function (partStream) {
  this.beginFlush();
  var emitAndReleaseHold = this.holdEmitQueue(partStream);
  var self=this;
  partStream.on('end', function() {
    self.endFlush();
  });
  emitAndReleaseHold(function() {
    self.emit('part', partStream);
  });
}

Form.prototype.handleFile=function(fileStream) {
  if (this.error) return;
  var publicFile = {
    fieldName: fileStream.name,
    originalFilename: fileStream.filename,
    path: uploadPath(this.uploadDir, fileStream.filename),
    headers: fileStream.headers,
    size: 0
  };
  var internalFile = {
    publicFile: publicFile,
    ls: null,
    ws: fs.createWriteStream(publicFile.path, { flags: 'wx' })
  };
  debugEvent("Event: Add File " + publicFile.path);
  this.openedFiles.push(internalFile)
  this.beginFlush(); // flush to write stream
  var emitAndReleaseHold = this.holdEmitQueue(fileStream);
  var self=this;
  fileStream.on('error', function(err) {
    self.handleError(err);
  });
  internalFile.ws.on('error', function (err) {
    self.handleError(err)
  })
  internalFile.ws.on('open', function () {
    // end option here guarantees that no more than that amount will be written
    // or else an error will be emitted
    internalFile.ls = new LimitStream(self.maxFilesSize - self.totalFileSize)
    internalFile.ls.pipe(internalFile.ws)

    internalFile.ls.on('error', function (err) {
      self.handleError(err.code === 'ETOOBIG'
        ? createError(413, err.message, { code: err.code })
        : err)
    });
    internalFile.ls.on('progress', function (totalBytes, chunkBytes) {
      publicFile.size = totalBytes
      self.totalFileSize += chunkBytes
    });
    internalFile.ws.on('close', function () {
      if (self.error) return;
      emitAndReleaseHold(function() {
        self.emit('file', fileStream.name, publicFile);
      });
      self.endFlush();
    });
    fileStream.pipe(internalFile.ls)
  });
}

Form.prototype.handleField=function (fieldStream) {
  var decoder = new StringDecoder(this.encoding);
  this.beginFlush();
  var emitAndReleaseHold = this.holdEmitQueue( fieldStream);
  var self=this;
  fieldStream.on('error', function(err) {
    self.handleError(err);
  });
  var value = '';
  fieldStream.on('readable', function() {
    var buffer = fieldStream.read();
    if (!buffer) return;

    self.totalFieldSize += buffer.length;
    if (self.totalFieldSize > self.maxFieldsSize) {
      self.handleError(createError(413, 'maxFieldsSize ' + self.maxFieldsSize + ' exceeded'));
      return;
    }
    value += decoder.write(buffer);
  });
  fieldStream.on('end', function() {
    emitAndReleaseHold(function() {
      self.emit('field', fieldStream.name, value);
    });
    self.endFlush();
  });
}

function uploadPath(baseDir, filename) {
  var ext = path.extname(filename).replace(FILE_EXT_RE, '$1');
  var name = uid.sync(18) + ext
  return path.join(baseDir, name);
}

function parseFilename(headerValue) {
  var m = headerValue.match(/\bfilename="(.*?)"($|; )/i);
  if (!m) {
    m = headerValue.match(/\bfilename\*=utf-8''(.*?)($|; )/i)
    if (m) {
      m[1] = decodeURI(m[1]);
    } else {
      return;
    }
  }
  var filename = m[1];
  filename = filename.replace(/%22|\\"/g, '"');
  filename = filename.replace(/&#([\d]{4});/g, function(m, code) {
    return String.fromCharCode(code);
  });
  return filename.substr(filename.lastIndexOf('\\') + 1);
}

function lower(c) {
  return c | 0x20;
}
