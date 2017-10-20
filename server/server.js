#!/usr/bin/env node
const debug = require('debug')('expressapp');
const express = require('express');
const path = require('path');
const logger = require('morgan');
const winston = require('winston');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const exphbs  = require('express-handlebars');
const proxy = require('http-proxy-middleware');
const querystring = require('querystring');
const url = require('url');
const fs = require('fs');

const zlib = require('zlib');

var app = express();

//This should be something like www.cancer.gov, dctd.cancer.gov, etc.
var proxyEnv = process.env.PROXY_ENV;
var useHttps = process.env.PROXY_HTTPS === 'true';

const contentTypeRegEx = /.*text\/html.*/i;

//We will use handlebars to deal with certain types of templating
//mainly error pages.  THIS SHOULD NOT BE USED FOR WEBSITE CONTENT!!!
//Node is not used for hosting web pages, and as such is not available
//to do templating.  If you need handlebars on the website, then you
//can use the client side version
app.engine('handlebars', exphbs({
    defaultLayout: 'main',
    layoutsDir: 'server/views/layouts/',
    partialsDir: ['server/views/partials/']
}));

app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

var env = process.env.NODE_ENV || 'development';
app.locals.ENV = env;
app.locals.ENV_DEVELOPMENT = env == 'development';

// Don't know hwat these next 4 app.use statements are for...
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(cookieParser());

/** Proxy expects http requests to specify a bare host name; however to request from an https site,
 * it requires the URL to begin with https://
 */
var scheme = '';
if(useHttps)
    scheme = 'https://';

/**
 * Function to inject the Return to NCI code into the head and body?
 * 
 * @param {any} body 
 * @returns 
 */
function injectReturnToNCI(body) {
    //TODO: Dr. Frank N. Furter -- you will need to figure out what you need here.  Will it load at top of head, will the script be async
    //can it be at the end of the body, etc.  The placement will matter.
    let modified = body;
    modified = body.replace(/(<\/head>)/i, '<link rel="stylesheet" href="/nci-global.css?site='+proxyEnv+'" /><script src="/returnToNCI-bar.js?site='+proxyEnv+'"></script>\n</head>');
    return modified;
}

function pickFile(path,file){
    var reqPath = "";
    try {
        var site = querystring.parse(url.parse(path).query).site;
        if (fs.existsSync('./dist/returnToNCI/' + site + file)) {
            console.log("using site specific file for:", file);
            reqPath = "/" + site;
        } else {
            console.log("using default file for:",file)
        }
    } catch (err) {
        console.log(err);
    }

    return path.replace(file, reqPath + file);
}

app.use('/nci-global.css',proxy({
        target: scheme + proxyEnv,
        changeOrigin: true,
        // onProxyRes: function (proxyRes, req, res) {
        //     console.log("nci-global.css request");
        // },
        // pathRewrite: {
        //     '/nci-global.css' : '/nci-global--visualsonline.css'
        // },
        pathRewrite: function (path, req) {
            return pickFile(path,'/nci-global.css')
        },
        router: {
            'localhost:3000' : 'http://localhost:3000/returnToNCI'
        }
    })
);

app.use('/returnToNCI-bar.js',proxy({
        target: scheme + proxyEnv,
        changeOrigin: true,
        pathRewrite: function (path, req) {
            return pickFile(path,'/returnToNCI-bar.js')
        },
        router: {
            'localhost:3000' : 'http://localhost:3000/returnToNCI'
        }
    })
);

//Try to fetch content locally
app.use(express.static(__dirname.replace("server","dist")));
app.use(express.static(__dirname.replace("server","dist/returnToNCI")));

/** Proxy Content that is not found on the server to www-blue-dev.cancer.gov **/
app.use(
    '*', //Match any paths
    //Setup the proxy to replace 
    proxy({
        target: scheme + proxyEnv,
        changeOrigin: true,
        onProxyRes: function(proxyRes, req, res) {

            //https://github.com/chimurai/http-proxy-middleware/issues/97
            if (
                proxyRes.headers && 
                proxyRes.headers['content-type'] &&
                proxyRes.headers['content-type'].match('text/html')
            ){
                winston.info('Rewriting Proxy Response -- tis HTML');

                const end = res.end;
                const writeHead = res.writeHead;
                const write = res.write;

                let writeHeadArgs;
                let body; 
                let buffer = new Buffer('');

                // Concat and unzip proxy response
                proxyRes
                  .on('data', (chunk) => {
                    buffer = Buffer.concat([buffer, chunk]);
                  })
                  .on('end', () => {
                    //Should probably account for deflate...
                    if (proxyRes.headers && proxyRes.headers['content-encoding'] == 'gzip') {
                        body = zlib.gunzipSync(buffer).toString('utf8');
                    } else {
                        body = buffer.toString('utf8');
                    }                   
                  });
            
                // Defer write and writeHead
                res.write = () => {};
                res.writeHead = (...args) => { writeHeadArgs = args; };
            
                // Update user response at the end
                res.end = () => {
                  const output = injectReturnToNCI(body); // some function to manipulate body
                  res.setHeader('content-length', output.length);
                  res.removeHeader('content-encoding');
                  writeHead.apply(res, writeHeadArgs);
            
                  write.apply( res, [output] );

                  end.apply(res, [""]);
                };
            }
        }
    })
);


/************************************************************
 * Error Handlers
 ************************************************************/
// catch unmapped items make a 404 error
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

//Development error handler will show stack traces
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err,
            title: 'error'
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {},
        title: 'error'
    });
});

/************************************************
 * Start listening on a port
 ************************************************/
app.set('port', process.env.PORT || 3000);
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // ignore certicate verification (i.e. Allow self-signed certs)

var server = app.listen(app.get('port'), function() {
    console.log('proxying "' + proxyEnv + '" at "localhost:' + server.address().port + '".');
});
