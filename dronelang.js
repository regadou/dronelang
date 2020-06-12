#!/usr/bin/node

const fs = require('fs');
const dgram = require('dgram');
const readline = require('readline');
const child_process = require('child_process');
const drone_host = '192.168.10.1';
const drone_port = 8889;
const drone_name = "TELLO-";
const status_port = 8890;
const stream_port = 11111;
const protocol = "udp4";
const maxPacketSize = 1460;
const responseTimeout = 2000;
const defaultMove = 20;
const messageEvent = "message";
const incompleteCommands = ["error Not joystick", "error No valid imu"];
const listenWord = "listen";
const startWords = "start,begin,on,ok".split(",");
const stopWords = "stop,done,end,off".split(",");
const exitCommands = 'exit quit'.split(' ');
const controlCommands = '911 wait connect video sim set file eval status fly go turn flip again voice history wifi now help'.split(' ');
const flightCommands = ('takeoff land forward back left right up down cw ccw speed rc').split(' ');
const directions = "front forward back up down left right".split(" ");
const connections = {command:null, status:null, stream:null};
const history = [];
const options = {};
const globalVariables = {};
const voiceStatus = {voice:false, listen:false};
const help_commands = function() {
   var commands = [];
   for (var c in exitCommands)
      commands.push(exitCommands[c]);
   for (var c in controlCommands)
      commands.push(controlCommands[c]);
   for (var c in flightCommands)
      commands.push(flightCommands[c]);
   for (var c in stopWords)
      commands.push(stopWords[c]);
   commands.push(listenWord);
   commands.sort();
   return commands;
}();

main(process.argv.slice(2));

async function main(files) {
   var eq, results = {};
   for (var f in files) {
      var file = files[f];
      if (file[0] == "-")
         setOption(file.substring(1));
      else if (file.indexOf(drone_name) == 0)
         mergeResults(results, await doControlCommand(["connect", file], globalVariables));
      else if ((eq = file.indexOf("=")) > 0)
         globalVariables[file.substring(0, eq)] = file.substring(eq+1);
      else if (fs.existsSync(file))
         mergeResults(results, await loadfile(file, globalVariables));
      else
         return console.log("Invalid parameter: "+file);
   }
   if (Object.keys(results).length)
      printValue(results);
   repl();
}

function setOption(option) {
   var key, value, index = option.indexOf("=");
   if (index < 0) {
      key = option;
      value = true;
   }
   else if (index > 0) {
      key = option.substring(0, index);
      value = option.substring(index+1);
   }
   else
      console.log("WARNING: ignoring option "+option);
   options[key] = value;
}

async function repl() {
   return new Promise(async function(resolve, reject) {
      const rl = readline.createInterface({
         input: process.stdin,
         output: process.stdout
      });

      rl.question("\n? ", async function (txt) {
         rl.close();
         txt = txt.trim();
         if (txt) {
            tokens = parseCommand(txt);
            var result = await execute(tokens, globalVariables);
            if (result != null)
               console.log("= "+printValue(result));
            if (tokens[0] != "last")
               history.push(tokens);
         }
         repl();
      });
   });
}

function printValue(value) {
   if (value == null)
      return "";
   switch (typeof(value)) {
      case "function":
         return value.toString().split("{")[0].trim();
      case "object":
         return JSON.stringify(value);
      default:
         return value.toString();
   }
}

async function loadfile(file, variables) {
   if (!fs.existsSync(file))
      return "file does not exists: "+file;
   if (fs.statSync(file).isDirectory())
      return "file is a directory: "+file;
   console.log("loading file "+file+" ...");
   var lines = fs.readFileSync(file, {encoding:"utf8"}).split("\n");
   var commands = [];
   var errors = [];
   var func = null;
   for (var i in lines) {
      var line = lines[i].trim();
      if (!line) {
         if (func != null) {
            variables[func.name] = compile_function(func);
            func = null;
         }
         continue;
      }
      var tokens = parseCommand(lines[i]);
      if (!tokens.length)
         continue;
      var cmd = tokens[0];
      var cmd2 = tokens[2];
      var vars = func ? func.variables : variables;
      var cmds = func ? func.commands : commands;
      if (cmd == "set") {
         if (cmd2 == "function") {
            if (func == null) {
               func = {
                  name: tokens[1], 
                  params: tokens.slice(3),
                  variables: {},
                  commands: []
               };
               variables[func.name] = null;
            }
            else
               addError(errors, file, i, null, "function definition inside function is not supported");
         }
         else {
            cmds.push(tokens);
            switch (tokens.length) {
               case 0:
               case 1:
                  break;
               case 2:
               case 3:
                  vars[tokens[1]] = null;
                  break;
               default:
                  if (help_commands.indexOf(cmd2) < 0)
                     addError(errors, file, i, cmd2);
                  else
                     vars[tokens[1]] = null;
            }
         }
      }
      else if (help_commands.indexOf(cmd) < 0 && Object.keys(vars).indexOf(cmd) < 0)
         addError(errors, file, i, token);
      else
         cmds.push(tokens);
   }
   if (errors.length)
      return errors.join("\n");
   if (!commands.length)
      return true;
   var results = {};
   for (var c in commands) {
      var cmd = commands[c];
      console.log(cmd.join(" "));
      var result = await execute(cmd, variables);
      if (result != null)
         console.log("= "+printValue(result));
      mergeResults(results, result);
   }
   return results;
}

function compile_function(func) {
   return async () => {
      var vars = func.variables.slice(0);
      for (var p in params)
         vars[params[p]] = arguments[p];
      var result = null;
      for (var c in func.commands)
         result = await execute(func.commands[c], vars);
      return result;
   }
}

function addError(errors, file, index, token, msg) {
   if (!msg)
      msg = "Undefined token '"+token+"'";
   errors.push(msg+" at line "+(parseInt(index)+1)+" in file "+file);
}

function mergeResults(results, value) {
   if (value == null)
      return;
   switch (typeof(value)) {
      case "string":
      case "boolean":
         var key = normalize(value);
         if (Object.keys(results).indexOf(key) < 0)
            results[key] = 1;
         else
            results[key]++;
         break;
      case "object":
         if (value instanceof Array) {
            for (var i in value)
               mergeResults(results, value[i]);
         }
         else {
            for (var i in value) {
               var v = value[i];
               var key = normalize(i);
               if (typeof(v) == "number") {
                  if (Object.keys(results).indexOf(key) < 0)
                     results[key] = v;
                  else
                     results[key] += n;
               }
            }
         }
   }
}

function normalize(value) {
   if (value == null)
      return "";
   return value.toString().split(":")[0].toLowerCase();
}

async function execute(tokens, variables) {
   if (voiceStatus.voice) {
      if (!voiceStatus.listen) {
         if (action == listenWord)
            return voiceStatus.listen = true;
         return "not listening";
      }
   }
   if (tokens.length) {
      var action = tokens[0];
      if (exitCommands.indexOf(action) >= 0)
         return process.exit(0);
      if (controlCommands.indexOf(action) >= 0)
         return await doControlCommand(tokens, variables);
      if (flightCommands.indexOf(action) >= 0 || action[action.length-1] == '?')
         return await doFlightCommand(tokens, variables);
      if (action == listenWord)
         return voiceStatus.listen = true;
      if (stopWords.indexOf(action) >= 0) {
         voiceStatus.listen = false;
         return "ok";
      }    
      if (Object.keys(variables).indexOf(action) < 0)
         return "invalid command: "+action;
      tokens = setVariables(tokens, variables);
      if (typeof(tokens[0]) == "function") {
         var result = await tokens[0].apply(this, tokens.slice(1));
         tokens = (result instanceof Array) ? result : [result];
      }
   }
   switch (tokens.length) {
      case 0:
         return null;
      case 1:
         return tokens[0];
      default:
         return tokens.join(" ");
   }
}

function parseCommand(txt) {
   var tokens = [];
   var token = null;
   for (var i in txt) {
      var c = txt[i];
      if (c <= ' ' || c > '~') {
         if (token != null)
            token = addToken(tokens, token);
      }
      else if (c == "#")
         break;
      else if (token == null)
         token = c;
      else
         token += c;
   }
   addToken(tokens, token);
   return tokens;
}

function addToken(tokens, token) {
   if (token != null)
      tokens.push(token);
}

function setVariables(tokens, variables) {
   var values = [];
   for (var t in tokens) {
      var token = tokens[t];
      var index = Object.keys(variables).indexOf(token);
      values.push((index < 0) ? token : variables[token]);
   }
   return values; 
}

async function doWait(params) {
   var time = 0;
   for (var p in params)
      time += parseFloat(params[p])||0;
   return new Promise(async function(resolve, reject) {
      setInterval(function(){ resolve("ok"); }, time*1000);
   });
}

async function doFlightCommand(cmd, variables) {
   if (cmd instanceof Array)
      cmd = setVariables(cmd, variables).join(" ");
   if (connections.command == null)
      return "sim "+cmd;
   cmd = new Buffer(cmd);
   var result;
   do {
      result = await sendCommand(cmd);
      if (incompleteCommands.indexOf(result) >= 0)
         console.log("WARNING: "+result);
   } while (incompleteCommands.indexOf(result) >= 0);
   return result;
}

async function sendCommand(cmd) {
   return new Promise(function(resolve, reject) {
      var listener = function(message) {
         clearTimeout(timer);
         connections.command.removeListener(messageEvent, listener);
         resolve(message.toString("utf8"));
      };
      var timer = setTimeout(function() {
         connections.command.removeListener(messageEvent, listener);
         resolve("timeout");
      }, responseTimeout);
      connections.command.on(messageEvent, listener);      
      connections.command.send(cmd, drone_port, drone_host);
   });
}

async function doControlCommand(tokens, variables) {
   if (tokens[0] == "set") {
      switch (tokens.length) {
         case 0:
         case 1:
            var keys = Object.keys(variables);
            keys.sort();
            return keys.join(" ");
         case 2:
            return delete variables[tokens[1]];
         case 3:
            return variables[tokens[1]] = setVariables([tokens[2]], variables)[0];
         default:
            var key = params[1];
            return variables[key] = await execute(params.slice(2), variables);
      }
   }
   var params = setVariables(tokens.slice(1), variables);
   switch (tokens[0]) {
      case "help":
         return help_commands.join(" ");
      case "911":
         return await doFlightCommand("emergency", variables);
      case "wait":
         return await doWait(params);
      case "file":
         var results = [];
         for (var p in params)
            results.push(await loadfile(params[p], variables));
         return (results.length > 1) ? results : results[0];
      case "eval":
         if (!params.length)
            return false;
         try { return eval(params.join(" ")); }
         catch (e) { return e.toString(); }
      case "connect":
         if (connections.command == null) {
            if (params[0]) {
               console.log("connecting to "+params[0]+" ...");
               await shell("nmcli c up "+params[0]);
            }
            connections.command = dgram.createSocket(protocol);
            connections.command.bind(drone_port);
            return await doFlightCommand("command", variables);
         }
         return true;
      case "wifi":
         if (!params.length)
            return "\n" + (await shell("nmcli d wifi list"));     
         return await doFlightCommand(tokens.join(" "), variables);
      case "sim":
         if (connections.command != null) {
            connections.command.close();
            connections.command = null;
         }
         return true;      
      case "status":
         if (!params.length)
            return doStatusConnection(true);
         if (params.length == 1 && stopWords.indexOf(params[0]) >= 0)
            return doStatusConnection(false);
         var results = [];
         for (var p in params) {
            var param = params[p];
            if (param[params.length-1] != "?")
               param += "?";
            results.push(await doFlightCommand(param, variables));
         }
         return results.join(" ");
      case "history":
         var commands = [];
         for (var h in history)
            commands.push(history[h].join(" "));
         return commands.join("\n");
      case "fly":
         return await doFlightCommand("takeoff", variables);
      case "go":
         return await move(params, variables);
      case "turn":
         return await turn(params, variables);
      case "flip":
         return await flip(params, variables);
      case "again":
         if (!params.length)
            params = [1];
         var results = [];
         for (var p in params) {
            var index = Math.abs(parseInt(params[p])||0);
            if (index && history.length-index >= 0)
               results.push(await execute(history[history.length-index], variables));
            else
               results.push(false);
         }
         return results.join("\n");
      case "video":
         if (!params.length)
            return "video parameter missing: live record file url "+stopWords.join(" ");
         if (stopWords.indexOf(params[0]) >= 0)
            return await doFlightCommand("streamoff", variables);
         var targets = [];
         for (var p in params) {
            var param = params[p];
            switch (param) {
               case "live":
                  targets.push(video_live());
                  break;
               case "record":
                  targets.push(video_file("data/"+printDate(new Date())+".raw"));
                  break;
               default:
                  //TODO: check if param is in the list of registered urls
                  var colon = param.indexOf(":");
                  if (colon < 0)
                     targets.push(video_file(param));
                  else
                     targets.push(video_url(param));
            }
         }
         doStreaming(targets);
         return await doFlightCommand("streamon", variables);
      case "now":
         return printDate(new Date());
      case "voice":
         if (!params.length || startWords.indexOf(params[0]) >= 0) {
            voiceStatus.listen = false;
            return voiceStatus.voice = true;
         }
         if (stopWords.indexOf(params[0]) >= 0) {
            voiceStatus.voice = false;
            return "ok";
         }
         return "invalid voice parameter: "+params.join(" ");
      default:
         return "command not implemented: "+tokens[0];
   }
}

function doStatusConnection(doit) {
   if (connections.command == null)
      return false;
   if (doit) {
      if (connections.status == null) {
         connections.status = dgram.createSocket(protocol);
         connections.status.on(messageEvent, function(message) {
            console.log(message.toString());
         });      
         connections.status.bind(status_port);
      }
   }
   if (connections.status != null) {
      connections.status.close();
      connections.status = null;
   }
   return true;
}

async function shell(command) {
   return new Promise(function(resolve, reject) {
      child_process.exec(command, function(error, stdout, stderr) { 
         console.error(stderr);
         if (error)
            reject(error);
         else
            resolve(stdout);
      });
   });
}

function video_live() {
   var player = child_process.exec("ffplay -loglevel quiet -");
   return bytes => player.stdin.write(bytes);
}

function video_file(file) {
   return bytes => fs.appendFileSync(file, bytes);
}

function video_url(url) {
   //TODO: send bytes to this url
   // - do we get or post to http ? it must be a post with application/octet-stream mimetype
   // - how to send to tcp or udp ? send raw bytes to the ip after uri scheme
}

function doStreaming(targets) {
//   var packets = [];
   connections.stream = dgram.createSocket(protocol);
   connections.stream.on(messageEvent, function(message) {
/*
      packets.push(message);
      if (message.length < maxPacketSize) {
         var bytes = Buffer.concat(packets);
         packets = [];
*/
         var bytes = message;
         for (var t in targets)
            targets[t](bytes);
//      }
   });      
   connections.stream.bind(stream_port);
}

function printDate(d) {
   return d.getFullYear()+(d.getMonth()+101).toString().substring(1)
                         +(d.getDate()+100).toString().substring(1)
                         +(d.getHours()+100).toString().substring(1)
                         +(d.getMinutes()+100).toString().substring(1)
                         +(d.getSeconds()+100).toString().substring(1);
}

async function move(params, variables) {
   var dir, step, done, results = {};
   for (var p in params) {
      var param = params[p];
      if (directions.indexOf(param) >= 0) {
         if (dir) {
            mergeResults(results, await doFlightCommand(dir+" "+(step||defaultMove)));
            step = null;
            done = true;
         }
         dir = (param == "front") ? "forward" : param;
      }
      else if (!isNaN(param)) {
         if (step == null)
            step = parseInt(param);
         else
            step += parseInt(param);
      }
      else if (Object.keys(variables).indexOf(param) >= 0) {
         //TODO: how to recursively set dir or step depending on variable value
      }
   }
   if (dir || step || !done)
      mergeResults(results, await doFlightCommand((dir||"forward")+" "+(step||defaultMove)));
   return results;
}

async function turn(params, variables) {
   var cmd, dir, step, done, results = {};
   for (var p in params) {
      var param = params[p];
      switch (param) {
         case "left":
            dir = "ccw";
            break;
         case "right":
            dir = "cw";
            break;
         default:
            dir = null;
            if (!isNaN(param)) {
               if (step == null)
                  step = parseInt(param);
               else
                  step += parseInt(param);
            }
            else if (Object.keys(variables).indexOf(param) >= 0) {
               //TODO: how to recursively set dir or step depending on variable value
            }
      }
      if (dir) {
         if (cmd)
            mergeResults(results, await doFlightCommand(cmd+" "+(step||defaultMove)));
         step = null;
         done = true;
         cmd = dir;
      }
   }
   if (cmd || step || !done)
      mergeResults(results, await doFlightCommand((cmd||"ccw")+" "+(step||defaultMove)));
   return results;
}

async function flip(params, variables) {
   var done, error, results = {};
   for (var p in params) {
      var param;
      switch (params[p]) {
         case "up":
            param = "b";
            break;
         case "down":
            param = "f";
            break;
         case "front":
         case "left":
         case "right":
         case "forward":
         case "back":
            param = params[p].charAt(0);
            break;
         default:
            mergeResults(results, "invalid flip parameter: "+params[p]);
            error = true;
            continue;
      }
      if (error || !param)
         continue;
      mergeResults(results, await doFlightCommand("flip "+param));
      done = true;
   }
   if (!error && !done)
      mergeResults(results, await doFlightCommand("flip forward"));
   return results;
}

