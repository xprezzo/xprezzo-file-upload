
var requireAll = require('require-all')

var Buffer = require('safe-buffer').Buffer;
var crypto = require('crypto');
var path = require('path');
var Pend = require('pend');
var rimraf = require('rimraf');
var fs = require('fs');
var http = require('http');
var net = require('net');
var stream = require('stream');
var assert = require('assert');
var multiparty = require('../');
var mkdirp = require('mkdirp');
var superagent = require('superagent');
var FIXTURE_PATH = path.join(__dirname, 'fixture');
var TMP_PATH = path.join(__dirname, 'tmp');

var standaloneTests = [
  {
    name: 'chunked',
    fn: function(cb) {
      var server = http.createServer(function(req, resp) {
        var form = new multiparty.Form();

        var partCount = 0;
        form.on('part', function(part) {
          part.resume();
          partCount++;
          assert.strictEqual(typeof part.byteCount, 'undefined');
        });
        form.on('close', function() {
          assert.strictEqual(partCount, 1);
          resp.end();
        });

        form.parse(req);
      });
      server.listen(function() {
        var socket = net.connect(server.address().port, 'localhost', function () {
          socket.write('POST / HTTP/1.1\r\n');
          socket.write('Host: localhost\r\n');
          socket.write('Connection: close\r\n');
          socket.write('Content-Type: multipart/form-data; boundary=foo\r\n');
          socket.write('Transfer-Encoding: chunked\r\n');
          socket.write('\r\n');
          socket.write('7\r\n');
          socket.write('--foo\r\n\r\n');
          socket.write('43\r\n');
          socket.write('Content-Disposition: form-data; name="file"; filename="plain.txt"\r\n\r\n');
          socket.write('12\r\n');
          socket.write('\r\nsome text here\r\n\r\n');
          socket.write('9\r\n');
          socket.write('--foo--\r\n\r\n');
          socket.write('0\r\n\r\n');
          socket.resume();
          socket.on('close', function () {
            server.close(cb);
          });
        });
      });
    }
  },
  {
    name: 'connection aborted closed',
    fn: function(cb) {
      var socket;
      var server = http.createServer(function (req, res) {
        var called = false;
        var form = new multiparty.Form();

        form.parse(req, function (err, fields, files) {
          assert.ok(!called);
          called = true;

          assert.ifError(err);
          assert.equal(Object.keys(fields).length, 1);
          socket.end();
        });
      });

      server.listen(0, 'localhost', function () {
        socket = net.connect(server.address().port, 'localhost', function () {
          socket.write('POST / HTTP/1.1\r\n');
          socket.write('Host: localhost\r\n');
          socket.write('Connection: close\r\n');
          socket.write('Content-Type: multipart/form-data; boundary=foo\r\n');
          socket.write('Transfer-Encoding: chunked\r\n');
          socket.write('\r\n');
          socket.write('7\r\n');
          socket.write('--foo\r\n\r\n');
          socket.write('2D\r\n');
          socket.write('Content-Disposition: form-data; name="data"\r\n\r\n');
          socket.write('12\r\n');
          socket.write('\r\nsome text here\r\n\r\n');
          socket.write('7\r\n');
          socket.write('--foo--\r\n');
          socket.write('2\r\n');
          socket.write('\r\n\r\n');
          socket.write('0\r\n\r\n');
          socket.resume();
          socket.on('close', function () {
            server.close(cb);
          });
        });
      });
    }
  },
  {
    name: 'connection aborted',
    fn: function(cb) {
      var server = http.createServer(function (req, res) {
        var form = new multiparty.Form();
        var aborted_received = false;
        form.on('aborted', function () {
          aborted_received = true;
        });
        form.on('error', function () {
          assert(aborted_received, 'Error event should follow aborted');
          server.close(cb);
        });
        form.on('end', function () {
          throw new Error('Unexpected "end" event');
        });
        form.on('close', function () {
          throw new Error('Unexpected "close" event');
        });
        form.parse(req);
      }).listen(0, 'localhost', function () {
        var client = net.connect(server.address().port);
        client.write(
          'POST / HTTP/1.1\r\n' +
          'Content-Length: 70\r\n' +
          'Content-Type: multipart/form-data; boundary=foo\r\n\r\n')
        client.end();
      });
    }
  },
  {
    name: 'connection aborted after close does error',
    fn: function (cb) {
      var body =
        '--foo\r\n' +
        'Content-Disposition: form-data; name="file1"; filename="file1"\r\n' +
        'Content-Type: application/octet-stream\r\n' +
        '\r\nThis is the file\r\n' +
        '--foo--\r\n'
      var client = null
      var error = null
      var server = http.createServer(function (req, res) {
        var form = new multiparty.Form()

        form.on('close', function () {
          client.destroy()
          setTimeout(function () {
            assert.ifError(error)
            server.close(cb)
          }, 100)
        })

        form.on('error', function (err) {
          error = err
        })

        form.on('part', function (part) {
          part.resume()
        })

        form.parse(req)
      }).listen(0, 'localhost', function () {
        client = net.connect(server.address().port)
        client.write(
          'POST / HTTP/1.1\r\n' +
          'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
          'Content-Type: multipart/form-data; boundary=foo\r\n\r\n' +
          body)
      });
    }
  },
  {
    name: 'content transfer encoding',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        var form = new multiparty.Form();
        form.uploadDir = TMP_PATH;
        form.on('close', function () {
          throw new Error('Unexpected "close" event');
        });
        form.on('end', function () {
          throw new Error('Unexpected "end" event');
        });
        form.on('error', function (e) {
          res.writeHead(e.status || 500);
          res.end(e.message);
        });
        form.parse(req);
      });

      server.listen(0, function() {
        var body =
          '--foo\r\n' +
          'Content-Disposition: form-data; name="file1"; filename="file1"\r\n' +
          'Content-Type: application/octet-stream\r\n' +
          '\r\nThis is the first file\r\n' +
          '--foo\r\n' +
          'Content-Type: application/octet-stream\r\n' +
          'Content-Disposition: form-data; name="file2"; filename="file2"\r\n' +
          'Content-Transfer-Encoding: unknown\r\n' +
          '\r\nThis is the second file\r\n' +
          '--foo--\r\n';

        var req = http.request({
          method: 'POST',
          port: server.address().port,
          headers: {
            'Content-Length': body.length,
            'Content-Type': 'multipart/form-data; boundary=foo'
          }
        });
        req.on('response', function (res) {
          assert.equal(res.statusCode, 400);
          res.on('data', function () {});
          res.on('end', function () {
            server.close(cb);
          });
        });
        req.end(body);
      });
    }
  },
  {
    name: 'emit order',
    fn: function(cb) {
      var bigFile = path.join(FIXTURE_PATH, 'file', 'pf1y5.png')

      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var fieldsInOrder = [
          'a',
          'b',
          'myimage.png',
          'c'
        ];

        var form = new multiparty.Form({
          autoFields: true
        });

        form.on('error', function (err) {
          assert.ifError(err);
        });

        form.on('part', function(part) {
          assert.ok(part.filename);
          var expectedFieldName = fieldsInOrder.shift();
          assert.strictEqual(part.name, expectedFieldName);
          part.resume();
        });

        form.on('field', function(name, value) {
          var expectedFieldName = fieldsInOrder.shift();
          assert.strictEqual(name, expectedFieldName);
        });

        form.on('close', function() {
          assert.strictEqual(fieldsInOrder.length, 0);
          res.end('OK')
        });

        form.parse(req);
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.field('a', 'a-value');
        req.field('b', 'b-value');
        req.attach('myimage.png', bigFile);
        req.field('c', 'hello');
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.on('response', function(res) {
          assert.equal(res.statusCode, 200);
          server.close(cb);
        });
        req.end();
      });
    }
  },
  {
    name: 'epilogue last chunk',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        var form = new multiparty.Form();

        var partCount = 0;
        form.on('part', function(part) {
          part.resume();
          partCount++;
        });
        form.on('close', function() {
          assert.strictEqual(partCount, 1);
          res.end();
        });

        form.parse(req);
      });
      server.listen(function() {
        var socket = net.connect(server.address().port, 'localhost', function () {
          socket.write('POST / HTTP/1.1\r\n');
          socket.write('Host: localhost\r\n');
          socket.write('Connection: close\r\n');
          socket.write('Content-Type: multipart/form-data; boundary=foo\r\n');
          socket.write('Transfer-Encoding: chunked\r\n');
          socket.write('\r\n');
          socket.write('7\r\n');
          socket.write('--foo\r\n\r\n');
          socket.write('43\r\n');
          socket.write('Content-Disposition: form-data; name="file"; filename="plain.txt"\r\n\r\n');
          socket.write('12\r\n');
          socket.write('\r\nsome text here\r\n\r\n');
          socket.write('7\r\n');
          socket.write('--foo--\r\n');
          socket.write('2\r\n');
          socket.write('\r\n\r\n');
          socket.write('0\r\n\r\n');
          socket.resume();
          socket.on('close', function () {
            server.close(cb);
          });
        });
      });
    }
  },
  {
    name: 'error listen after parse',
    fn: function(cb) {
      var form = new multiparty.Form();
      var req = new stream.Readable();

      req.headers = {};
      req._read = function(){
        this.push(Buffer.from('--foo!'));
      };

      form.parse(req);

      form.on('error', function(err){
        // verification that error emitter when attached after form.parse
        assert.ok(err);
        cb();
      });
    }
  },
  {
    name: 'error unpipe',
    fn: function(cb) {
      var err = null;
      var form = new multiparty.Form();
      var pend = new Pend();
      var req = new stream.Readable();
      var unpiped = false;

      req.headers = {
        'content-type': 'multipart/form-data; boundary=foo'
      };
      req._read = function(){
        this.push(Buffer.from('--foo!'));
      };

      pend.go(function(cb){
        form.on('error', function(e){
          err = e;
          cb();
        });
      });

      pend.go(function(cb){
        form.on('unpipe', function(){
          unpiped = true;
          cb();
        });
      });

      pend.wait(function(){
        // verification that error event implies unpipe call
        assert.ok(err);
        assert.ok(unpiped, 'req was unpiped');

        assert.ok(!isReadableStreamFlowing(req), 'req not flowing')
        assert.equal(getReadableStreamPipeCount(req), 0, 'req has 0 pipes')
        cb();
      })

      form.parse(req)

      assert.ok(isReadableStreamFlowing(req), 'req flowing')
      assert.equal(getReadableStreamPipeCount(req), 1, 'req has 1 pipe')
    }
  },
  {
    name: 'invalid',
    fn: function(cb) {
      var server = http.createServer(function(req, resp) {
        var form = new multiparty.Form();

        form.on('error', function(err) {
          resp.end();
        });
        form.on('file', function(name, file) {
        });
        form.on('field', function(name, file) {
        });

        form.parse(req);
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/'
        var req = superagent.post(url)
        req.set('Content-Type', 'multipart/form-data; boundary=foo')
        req.write('--foo\r\n')
        req.write('Content-filename="foo.txt"\r\n')
        req.write('\r\n')
        req.write('some text here')
        req.write('Content-Disposition: form-data; name="text"; filename="bar.txt"\r\n')
        req.write('\r\n')
        req.write('some more text stuff')
        req.write('\r\n--foo--')
        req.end(function(err, resp) {
          resp.resume()
          server.close(cb);
        });
      });
    }
  },
  {
    name: 'issue 15',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form({ autoFields: true, autoFiles: true })

        form.on('error', function(err) {
          console.log(err);
        });

        form.on('close', function() {
        });

        var fileCount = 0;
        form.on('file', function(name, file) {
          fileCount += 1;
          fs.unlink(file.path, function () {});
        });

        form.parse(req, function(err, fields, files) {
          var objFileCount = Object.keys(files).length;
          // multiparty does NOT try to do intelligent things based on
          // the part name.
          assert.strictEqual(fileCount, 2);
          assert.strictEqual(objFileCount, 1);
          res.end();
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('files[]', fixture('pf1y5.png'), 'SOG2.JPG');
        req.attach('files[]', fixture('binaryfile.tar.gz'), 'BenF364_LIB353.zip');

        req.end(function(err, resp) {
          assert.ifError(err);
          resp.resume()
          server.close(cb)
        });

        // No space.
        createRequest('');

        // Single space.
        createRequest(' ');

        // Multiple spaces.
        createRequest('    ');
      });

      function createRequest(separator) {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('files[]', fixture('pf1y5.png'), 'SOG2.JPG');
        req.attach('files[]', fixture('binaryfile.tar.gz'), 'BenF364_LIB353.zip');

        req.end(function(err, resp) {
          assert.ifError(err);
          // We don't close the server, to allow other requests to pass.
        });
      }

      function fixture(name) {
        return path.join(FIXTURE_PATH, 'file', name)
      }
    }
  },
  {
    name: 'maxFields error',
    fn: function(cb) {
      var client;
      var server = http.createServer(function (req, res) {
        var form = new multiparty.Form({ maxFields: 1 })
        form.on('aborted', function () {
          throw new Error('did not expect aborted')
        });
        var first = true;
        form.on('error', function (err) {
          assert.ok(first);
          first = false;
          client.end();
          assert.ok(/maxFields/.test(err.message));
          assert.equal(err.status, 413);
          server.close(cb);
        });
        form.on('end', function () {
          throw new Error('Unexpected "end" event');
        });
        form.parse(req);
      });
      server.listen(function() {
        client = net.connect(server.address().port);

        client.write('POST /upload HTTP/1.1\r\n' +
          'Content-Length: 728\r\n' +
          'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="title"\r\n' +
          '\r\n' +
          'foofoo' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="upload"; filename="blah1.txt"\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          'hi1\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n')
      });
    }
  },
  {
    name: 'maxFieldsSize error',
    fn: function(cb) {
      var client;
      var server = http.createServer(function (req, res) {
        var form = new multiparty.Form({ maxFieldsSize: 8 })
        form.on('aborted', function () {
          throw new Error('did not expect aborted')
        });
        var first = true;
        form.on('error', function (err) {
          assert.ok(first);
          first = false;
          client.end();
          assert.ok(/maxFieldsSize/.test(err.message));
          assert.equal(err.status, 413);
          server.close(cb);
        });
        form.on('end', function () {
          throw new Error('Unexpected "end" event');
        });
        form.on('field', function () {});
        form.parse(req);
      });
      server.listen(function() {
        client = net.connect(server.address().port);

        client.write('POST /upload HTTP/1.1\r\n' +
          'Content-Length: 678\r\n' +
          'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="title"\r\n' +
          '\r\n' +
          'foofoo' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="text"\r\n' +
          '\r\n' +
          'hi1\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n')
      });
    }
  },
  {
    name: 'issue 21',
    fn: function(cb) {
      var client;
      var server = http.createServer(function(req, res) {
        var form = new multiparty.Form();

        form.parse(req, function(err, fields, files) {
          if (err) {
            console.error(err.stack);
            return;
          }
          var nameCount = 0;
          var name;
          for (name in fields) {
            assert.strictEqual(name, 'title')
            nameCount += 1;

            var values = fields[name];
            assert.strictEqual(values.length, 1);
            assert.strictEqual(values[0], 'foofoo')
          }
          assert.strictEqual(nameCount, 1);

          nameCount = 0;
          for (name in files) {
            assert.strictEqual(name, 'upload')
            nameCount += 1;

            var filesList = files[name];
            assert.strictEqual(filesList.length, 4);
            filesList.forEach(assertAndUnlink);
          }

          assert.strictEqual(nameCount, 1);

          res.end();
          client.end();
          server.close(cb);

          function assertAndUnlink(file){
            assert.strictEqual(file.fieldName, 'upload')
            fs.unlinkSync(file.path);
          }
        });
      });
      server.listen(function() {
        client = net.connect(server.address().port);

        client.write('POST /upload HTTP/1.1\r\n' +
          'Content-Length: 726\r\n' +
          'Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="title"\r\n' +
          '\r\n' +
          'foofoo' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="upload"; filename="blah1.txt"\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          'hi1\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="upload"; filename="blah2.txt"\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          'hi2\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="upload"; filename="blah3.txt"\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          'hi3\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="upload"; filename="blah4.txt"\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          'hi4\r\n' +
          '\r\n' +
          '------WebKitFormBoundaryvfUZhxgsZDO7FXLF--\r\n'
        );
      });
    }
  },
  {
    name: 'issue 32',
    fn: function(cb) {
      var client;
      var server = http.createServer(function(req, res) {
        var form = new multiparty.Form();

        form.parse(req, function(err, fields, files) {
          if (err) {
            console.error(err.stack);
            return;
          }
          assert.strictEqual(files.image[0].originalFilename, '测试文档')
          fs.unlinkSync(files.image[0].path);
          res.end();
          client.end();
          server.close(cb);
        });
      });
      server.listen(function() {
        client = net.connect(server.address().port);

        client.write(
          'POST /upload HTTP/1.1\r\n' +
          'Accept: */*\r\n' +
          'Content-Type: multipart/form-data; boundary="893e5556-f402-4fec-8180-c59333354c6f"\r\n' +
          'Content-Length: 187\r\n' +
          '\r\n' +
          '--893e5556-f402-4fec-8180-c59333354c6f\r\n' +
          "Content-Disposition: form-data; name=\"image\"; filename*=utf-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3\r\n" +
          '\r\n' +
          '\r\n' +
          '--893e5556-f402-4fec-8180-c59333354c6f--\r\n'
        );
      });
    }
  },
  {
    name: 'issue 36',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        var form = new multiparty.Form();
        var endCalled = false;
        form.on('part', function(part) {
          part.on('end', function() {
            endCalled = true;
          });
          part.resume();
        });
        form.on('close', function() {
          assert.ok(endCalled);
          res.end();
        });
        form.parse(req);
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/'
        var req = superagent.post(url)
        req.set('Content-Type', 'multipart/form-data; boundary=--WebKitFormBoundaryvfUZhxgsZDO7FXLF')
        req.set('Content-Length', '186')
        req.write('----WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n');
        req.write('Content-Disposition: form-data; name="upload"; filename="blah1.txt"\r\n');
        req.write('Content-Type: plain/text\r\n');
        req.write('\r\n');
        req.write('hi1\r\n');
        req.write('\r\n');
        req.write('----WebKitFormBoundaryvfUZhxgsZDO7FXLF--\r\n');
        req.end(function(err, resp) {
          server.close(cb);
        });
      });
    }
  },
  {
    name: 'issue 4',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form({ autoFields: true, autoFiles: true })

        form.on('error', function(err) {
          console.log(err);
        });

        form.on('close', function() {
        });

        var fileCount = 0;
        form.on('file', function(name, file) {
          fileCount += 1;
          fs.unlink(file.path, function () {});
        });

        form.parse(req, function(err, fields, files) {
          var objFileCount = Object.keys(files).length;
          // multiparty does NOT try to do intelligent things based on
          // the part name.
          assert.strictEqual(fileCount, 2);
          assert.strictEqual(objFileCount, 1);
          res.end();
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('files[]', fixture('pf1y5.png'), 'SOG2.JPG');
        req.attach('files[]', fixture('binaryfile.tar.gz'), 'BenF364_LIB353.zip');
        req.end(function(err, resp) {
          assert.ifError(err);
          resp.resume()
          server.close(cb)
        });
      });
      function fixture(name) {
        return path.join(FIXTURE_PATH, 'file', name)
      }
    }
  },
  {
    name: 'max fields',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form({ autoFiles: true, maxFields: 2 })

        var first = true;
        form.on('error', function (err) {
          assert.ok(first);
          first = false;
          assert.ok(/maxFields/.test(err.message));
          assert.equal(err.status, 413);
        });

        var fieldCount = 0;
        form.on('field', function() {
          fieldCount += 1;
        });

        form.parse(req, function(err, fields, files) {
          assert.ok(!first);
          assert.ok(fieldCount <= 2);
          res.statusCode = 413;
          res.end('too many fields');
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        var val = Buffer.alloc(10 * 1024);
        req.field('a', val);
        req.field('b', val);
        req.field('c', val);
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.on('response', function(res) {
          assert.equal(res.statusCode, 413);
          server.close(cb);
        });
      });
    }
  },
  {
    name: 'max files size exact',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form({ autoFiles: true, maxFilesSize: 768323 }) // exact size of pf1y5.png

        var fileCount = 0;
        form.on('file', function(name, file) {
          fileCount += 1;
          fs.unlink(file.path, function() {});
        });

        form.parse(req, function(err, fields, files) {
          assert.ifError(err);
          assert.ok(fileCount === 1);
          res.end('OK');
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('file0', fixture('pf1y5.png'), 'SOG1.JPG');
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.on('response', function(res) {
          assert.equal(res.statusCode, 200);
          server.close(cb);
        });
      });

      function fixture(name) {
        return path.join(FIXTURE_PATH, 'file', name)
      }
    }
  },
  {
    name: 'max files size',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form({ autoFiles: true, maxFilesSize: 800 * 1024 })

        var first = true;
        form.on('error', function (err) {
          assert.ok(first);
          first = false;
          assert.strictEqual(err.code, 'ETOOBIG');
          assert.strictEqual(err.status, 413);
        });

        var fileCount = 0;
        form.on('file', function(name, file) {
          fileCount += 1;
          fs.unlinkSync(file.path);
        });

        form.parse(req, function(err, fields, files) {
          assert.ok(fileCount <= 1);
          res.statusCode = 413;
          res.end('files too large');
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('file0', fixture('pf1y5.png'), 'SOG1.JPG');
        req.attach('file1', fixture('pf1y5.png'), 'SOG2.JPG');
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.on('response', function(res) {
          assert.equal(res.statusCode, 413);
          server.close(cb);
        });
      });

      function fixture(name) {
        return path.join(FIXTURE_PATH, 'file', name)
      }
    }
  },
  {
    name: 'max files size edge',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form({
          autoFiles: true,
          maxFilesSize: (768323 * 2) - 1 // exact size of 2 x pf1y5.png - 1
        });

        var first = true;
        form.on('error', function (err) {
          assert.ok(first);
          first = false;
          assert.strictEqual(err.code, 'ETOOBIG');
          assert.strictEqual(err.status, 413);
        });

        var fileCount = 0;
        form.on('file', function(name, file) {
          fileCount += 1;
          fs.unlinkSync(file.path);
        });

        form.parse(req, function(err, fields, files) {
          assert.ok(fileCount <= 2);
          res.statusCode = 413;
          res.end('files too large');
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('file0', fixture('pf1y5.png'), 'SOG1.JPG');
        req.attach('file1', fixture('pf1y5.png'), 'SOG1.JPG');
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.on('response', function(res) {
          assert.equal(res.statusCode, 413);
          server.close(cb);
        });
      });

      function fixture(name) {
        return path.join(FIXTURE_PATH, 'file', name)
      }
    }
  },
  {
    name: 'missing boundary end',
    fn: function(cb) {
      var server = http.createServer(function(req, resp) {
        var form = new multiparty.Form();

        var errCount = 0;
        form.on('error', function (err) {
          assert.ok(err);
          assert.equal(err.message, 'stream ended unexpectedly');
          assert.equal(err.status, 400);
          errCount += 1;
          resp.end();
        });
        form.on('part', function (part) {
          part.resume();
        });
        form.on('close', function () {
          assert.equal(errCount, 1);
        })

        form.parse(req);
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/'
        var req = superagent.post(url)
        req.set('Content-Type', 'multipart/form-data; boundary=--WebKitFormBoundaryE19zNvXGzXaLvS5C')
        req.write('----WebKitFormBoundaryE19zNvXGzXaLvS5C\r\n');
        req.write('Content-Disposition: form-data; name="a[b]"\r\n');
        req.write('\r\n');
        req.write('3\r\n');
        req.write('----WebKitFormBoundaryE19zNvXGzXaLvS5C\r\n');
        req.write('Content-Disposition: form-data; name="a[c]"\r\n');
        req.write('\r\n');
        req.write('4\r\n');
        req.write('----WebKitFormBoundaryE19zNvXGzXaLvS5C\r\n');
        req.write('Content-Disposition: form-data; name="file"; filename="test.txt"\r\n');
        req.write('Content-Type: plain/text\r\n');
        req.write('\r\n');
        req.write('and\r\n');
        req.write('----WebKitFormBoundaryE19zNvXGzXaLvS5C\r\n');
        req.end(function(err, resp) {
          server.close(cb);
        });
      });
    }
  },
  {
    name: 'missing content-type error',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form();

        form.parse(req, function(err, fields, files) {
          assert.ok(err);
          assert.equal(err.message, 'missing content-type header');
          assert.equal(err.status, 415);
          res.statusCode = 415;
          res.end();
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.on('response', function(res) {
          assert.equal(res.statusCode, 415);
          server.close(cb);
        });
      });
    }
  },
  {
    name: 'unsupported content-type error',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form();

        form.parse(req, function(err, fields, files) {
          assert.ok(err);
          assert.equal(err.message, 'unsupported content-type');
          assert.equal(err.status, 415);
          res.statusCode = 415;
          res.end();
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.set('Content-Type', 'application/json');
        req.write('{}');
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.on('response', function(res) {
          assert.equal(res.statusCode, 415);
          server.close(cb);
        });
      });
    }
  },
  {
    name: 'content-type missing boundary error',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form();

        form.parse(req, function(err, fields, files) {
          assert.ok(err);
          assert.equal(err.message, 'content-type missing boundary');
          assert.equal(err.status, 400);
          res.statusCode = 400;
          res.end();
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('file0', fixture('pf1y5.png'), 'SOG1.JPG');
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.req.setHeader('Content-Type', 'multipart/form-data')
        req.on('response', function(res) {
          assert.equal(res.statusCode, 400);
          server.close(cb);
        });
      });

      function fixture(name) {
        return path.join(FIXTURE_PATH, 'file', name)
      }
    }
  },
  {
    name: 'empty header field error',
    fn: function(cb) {
      var server = http.createServer(function(req, resp) {
        var form = new multiparty.Form();

        var partCount = 0;
        form.on('part', function(part) {
          part.resume();
          partCount++;
          assert.strictEqual(typeof part.byteCount, 'undefined');
        });
        form.on('error', function(err) {
          assert.ok(err);
          assert.equal(err.message, 'Empty header field');
          assert.equal(err.statusCode, 400);
          assert.equal(partCount, 0);
          server.close(cb);
        });
        form.on('close', function() {
          throw new Error('Unexpected "close" event');
        });

        form.parse(req);
      });
      server.listen(function() {
        var socket = net.connect(server.address().port, 'localhost', function () {
          socket.write('POST / HTTP/1.1\r\n');
          socket.write('Host: localhost\r\n');
          socket.write('Connection: close\r\n');
          socket.write('Content-Type: multipart/form-data; boundary=foo\r\n');
          socket.write('Transfer-Encoding: chunked\r\n');
          socket.write('\r\n');
          socket.write('7\r\n');
          socket.write('--foo\r\n\r\n');
          socket.write('46\r\n');
          socket.write('Content-Disposition: form-data; name="file"; filename="plain.txt"\r\n:\r\n\r\n');
          socket.write('12\r\n');
          socket.write('\r\nsome text here\r\n\r\n');
          socket.write('9\r\n');
          socket.write('--foo--\r\n\r\n');
          socket.write('0\r\n\r\n');
          socket.end();
        });
      });
    }
  },
  {
    name: 'request encoding',
    fn: function(cb) {
      var server = http.createServer(function(req, res) {
        assert.strictEqual(req.url, '/upload');
        assert.strictEqual(req.method, 'POST');

        var form = new multiparty.Form();

        // this is invalid
        req.setEncoding('utf8');

        form.parse(req, function(err, fields, files) {
          assert.ok(err);
          assert.equal(err.message, 'request encoding must not be set');
          res.statusCode = 500;
          res.end();
        });
      });
      server.listen(function() {
        var url = 'http://localhost:' + server.address().port + '/upload';
        var req = superagent.post(url);
        req.attach('file0', fixture('pf1y5.png'), 'SOG1.JPG');
        req.on('error', function(err) {
          assert.ifError(err);
        });
        req.end();
        req.on('response', function(res) {
          assert.equal(res.statusCode, 500);
          server.close(cb);
        });
      });

      function fixture(name) {
        return path.join(FIXTURE_PATH, 'file', name)
      }
    }
  },
  {
    name: 'stream error',
    fn: function(cb) {
      var server = http.createServer(function (req, res) {
        var form = new multiparty.Form();
        var gotPartErr;
        form.on('part', function(part) {
          part.on('error', function(err) {
            gotPartErr = err;
          });
          part.resume();
        });
        form.on('error', function () {
          assert.ok(gotPartErr);
          server.close(cb);
        });
        form.on('close', function () {
          throw new Error('Unexpected "close" event');
        });
        form.parse(req);
      }).listen(0, 'localhost', function () {
        var client = net.connect(server.address().port);
        client.write(
          'POST / HTTP/1.1\r\n' +
          'Content-Length: 186\r\n' +
          'Content-Type: multipart/form-data; boundary=--WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          '\r\n' +
          '----WebKitFormBoundaryvfUZhxgsZDO7FXLF\r\n' +
          'Content-Disposition: form-data; name="upload"; filename="blah1.txt"\r\n' +
          'Content-Type: plain/text\r\n' +
          '\r\n' +
          'hi1\r\n')
        client.end();
      });
    }
  },
  {
    name: 'queued part error',
    fn: function(cb) {
      var server = http.createServer(function (req, res) {
        var form = new multiparty.Form();
        var pend = new Pend();

        pend.go(function(cb){
          form.on('part', function(part){
            part.on('error', function(err){
              assert.ok(err);
              assert.equal(err.message, 'stream ended unexpectedly');
              cb();
            });
            part.resume();
          });
        });

        pend.go(function(cb){
          form.on('field', function(){
            cb();
          });
        });

        pend.go(function(cb){
          form.on('error', function(err){
            assert.ok(err);
            assert.equal(err.message, 'stream ended unexpectedly');
            cb();
          });
        });

        pend.wait(function(){
          server.close(cb);
        });

        form.on('close', function () {
          throw new Error('Unexpected "close" event');
        });

        form.parse(req);
      }).listen(0, 'localhost', function () {
        var client = net.connect(server.address().port);
        client.end(
          'POST / HTTP/1.1\r\n' +
          'Content-Length: 174\r\n' +
          'Content-Type: multipart/form-data; boundary=--bounds\r\n' +
          '\r\n' +
          '----bounds\r\n' +
          'Content-Disposition: form-data; name="key"\r\n' +
          '\r\n' +
          'hi\r\n' +
          '----bounds\r\n' +
          'Content-Disposition: form-data; name="upload"; filename="blah1.txt"\r\n' +
          'Content-Type: plain/text\r\n' +
          '\r\n' +
          'bye')
      });
    }
  },
  {
    name: 'issue 198',
    fn: function(cb) {
      var client;
      var server = http.createServer(function(req, res) {
        var form = new multiparty.Form();

        form.parse(req, function(err, fields, files) {
          if (err) {
            console.error(err.stack);
            return;
          }
          assert.strictEqual(path.extname(files.image[0].path), '.y')
          assert.strictEqual(files.image[0].originalFilename, 'x.y\u2028%24(echo subshell)')
          fs.unlinkSync(files.image[0].path);
          res.end();
          client.end();
          server.close(cb);
        });
      });
      server.listen(function() {
        client = net.connect(server.address().port);

        client.write(
          'POST /upload HTTP/1.1\r\n' +
          'Accept: */*\r\n' +
          'Content-Type: multipart/form-data; boundary="893e5556-f402-4fec-8180-c59333354c6f"\r\n' +
          'Content-Length: 217\r\n' +
          '\r\n' +
          '--893e5556-f402-4fec-8180-c59333354c6f\r\n' +
          "Content-Disposition: form-data; name=\"image\"; filename*=utf-8''%78%2E%79%E2%80%A8%24%28%65%63%68%6F%20%73%75%62%73%68%65%6C%6C%29\r\n" +
          '\r\n' +
          '\r\n' +
          '--893e5556-f402-4fec-8180-c59333354c6f--\r\n'
        );
      });
    }
  }
];

describe('multiparty', function () {
  before(function (done) {
    rimraf(TMP_PATH, function (err) {
      if (err) return done(err)
      mkdirp(TMP_PATH, done)
    })
  })

  after(function (done) {
    rimraf(TMP_PATH, done)
  })

  describe('fixture tests', function () {
    var fixtureServer = http.createServer()
    var fixtureTests = requireAll(path.join(FIXTURE_PATH, 'js'))

    before(function (done) {
      fixtureServer.listen(done)
    })

    after(function (done) {
      fixtureServer.close(done)
    })

    Object.keys(fixtureTests).forEach(function (group) {
      describe(group, function () {
        Object.keys(fixtureTests[group]).forEach(function (name) {
          it(path.basename(name, '.http'),
            createFixtureTest(fixtureServer, (group + '/' + name), fixtureTests[group][name]))
        })
      })
    })
  })

  describe('standalone tests', function () {
    standaloneTests.forEach(function (test) {
      it(test.name, test.fn)
    })
  })
})

function createFixtureTest(server, name, fixture) {
  return function(cb) {
    uploadFixture(server, path.join(FIXTURE_PATH, 'http', name), function (err, parts) {
      if (err) return cb(err)
      fixture.forEach(function(expectedPart, i) {
        var parsedPart = parts[i];
        assert.equal(parsedPart.type, expectedPart.type);
        assert.equal(parsedPart.name, expectedPart.name);

        if (parsedPart.type === 'file') {
          var file = parsedPart.value;
          assert.equal(file.originalFilename, expectedPart.filename);
          if(expectedPart.sha1) assert.strictEqual(file.hash, expectedPart.sha1);
          if(expectedPart.size) assert.strictEqual(file.size, expectedPart.size);
        }
      });
      cb();
    });
  };
}

function computeSha1(o) {
  return function(cb) {
    var file = o.value;
    var hash = fs.createReadStream(file.path).pipe(crypto.createHash('sha1'));
    hash.read(); // work around pre-https://github.com/joyent/node/commit/4bf1d1007fbd249d1d07b662278a5a34c6be12fd
    hash.on('data', function(digest) {
      fs.unlinkSync(file.path);
      file.hash = digest.toString('hex');
      cb();
    });
  };
}

function getReadableStreamPipeCount (stream) {
  var count = stream._readableState.pipesCount

  return typeof count !== 'number'
    ? stream._readableState.pipes.length
    : count
}

function isReadableStreamFlowing (stream) {
  return Boolean(stream._readableState.flowing)
}

function uploadFixture(server, path, cb) {
  server.once('request', function(req, res) {
    var done = false
    var parts = [];
    var form = new multiparty.Form({
      autoFields: true,
      autoFiles: true
    });
    form.uploadDir = TMP_PATH;
    var pend = new Pend();

    form.on('error', callback);
    form.on('file', function(name, value) {
      var o = { type: 'file', name: name, value: value }
      parts.push(o);
      pend.go(computeSha1(o));
    });
    form.on('field', function(name, value) {
      parts.push({ type: 'field', name: name, value: value })
    });
    form.on('close', function() {
      res.end('OK');
      pend.wait(function(err) {
        if (err) throw err;
        callback(null, parts);
      });
    });
    form.parse(req);

    function callback() {
      if (done) return
      done = true
      cb.apply(null, arguments)
    }
  });

  var port = server.address().port
  var socket = net.createConnection(port)
  var file = fs.createReadStream(path)

  file.pipe(socket, { end: false })
  socket.on('data', function () {
    socket.end();
  });
}
