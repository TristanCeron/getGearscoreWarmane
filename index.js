const http = require('http');
var url = require("url");
const async = require('async');
const axios = require('axios');
var parseString = require('xml2js').parseString;
var redis = require('redis');
var CronJob = require('cron').CronJob;

/*
*Environment Variable
*/
const port = process.env.PORT || 5000;
const guild = process.env.GUILD || "Utopie";
const server = process.env.SERVER || "Lordaeron";

var client = redis.createClient(process.env.REDIS_URL);
const {promisify} = require('util');
const getAsync = promisify(client.get).bind(client);

/**
*   Global variable used in Gearscore calculations
**/


var scale = 1.8618;

var GS_Formula_A = [
  { A: 73.0000, B: 1.0000 },//2
  { A: 81.3750, B: 0.8125 },//3
  { A: 91.4500, B: 0.6500 } //4
];

var GS_Formula_B = [
  { A: 0.0000, B: 2.2500 },//1
  { A: 8.0000, B: 2.0000 },//2
  { A: 0.7500, B: 1.8000 },//3
  { A: 26.000, B: 1.2000 } //4
];

var slotWeight = [0, 1, 0.5625, 0.75, 0, 1, 0.75, 1, 0.75, 0.5625, 0.75, 0.5625, 0.5625, 0, 0, 0.3164, 0.5625, 2, 0.3164];


var lastcall = 0;

/*** Returns the gearscore of a given item piece */
var getItemGearscore = async function (item, isFury, callback) {
  var cachedGS = await getAsync(item);
  
  if (cachedGS != null && isFury == false) {
    //console.log("gs cached")
    callback(cachedGS);
  } else {
    /*** Miscellaneous Variables ***/
    var qualityScale = 1;
    var gs = 0;

    /*** Http request to wotlk.evow servers to get the item infos for gs calculations ***/
    axios.get("https://wotlk.evowow.com/?item=" + item + "&xml")
      .then(async response => {
        parseString(response.data, function (err, result) {
          var w = JSON.parse(JSON.stringify(result));
          var ilvl = w.aowow.item[0].level[0];
          var quality = w.aowow.item[0].quality[0].$.id;
          var slot = w.aowow.item[0].inventorySlot[0].$.id;

          /*** Quality checks to adjust the qualityScale ***/
          if (quality == 5) {
            qualityScale = 1.3;
            quality = 4;
          } else if (quality == 0 || quality == 1) {
            qualityScale = 0.005;
            quality = 2;
          }
          if (quality == 7) {
            quality = 3;
            ilvl = 187.05;
          }

          /*** Slots checks to adjust slot weight **/
          if (slot == 13 || slot == 14 || slot == 21 || slot == 22 || slot == 23) slot = 7;
          else if (slot == 28) slot = 18;
          else if (slot == 19) slot = 4;
          else if (slot == 25) slot = 15;
          else if (slot == 17 && isFury) slot = 7; //If the warrior has a fury spec, the value of a 2h weapon is halved

          /*** GS is calculated ***/
          if (ilvl >= 120) {
            gs = ((ilvl - GS_Formula_A[quality - 2].A) / GS_Formula_A[quality - 2].B) * scale * qualityScale * slotWeight[slot];
          } else {
            gs = ((ilvl - GS_Formula_B[quality - 1].A) / GS_Formula_B[quality - 1].B) * scale * qualityScale * slotWeight[slot];
          }
          if (gs <= 0) gs = 0;
          gs = Math.floor(gs);
          if (isFury == false) client.set(toString(item), Math.floor(gs));
          callback(gs);
        });
      })
      .catch(error => {
        console.log(error);
        callback(0);
      });
  }
}

/*** Gets member infos from warmane API and calls the gs calculations */
var getCharInfo = async function (name, callback) {
  var gearscore = 0;
  var isFury = false;

  axios.get("https://armory.warmane.com/api/character/" + name + "/" + server + "/summary")
    .then(async response => {
      lastcall = Date.now();
      //console.log(response.data);
      async.eachSeries(response.data.equipment, function (item, callback) {

        setTimeout(async function () {

          await getItemGearscore(item.item, (response.data.talents.findIndex(i => i.tree === "Fury") >= 0), function (data) {
            //console.log(data);
            gearscore += parseInt(data);
            callback();
          });
        }, 1);

      }, async function (err) {
        if (err) console.log(err);
        else {
          console.log('iterating done');
          
          var profession1Txt = "";
          var profession1SkillTxt = "";
          var profession2Txt = "";
          var profession2SkillTxt = "";

          for(i =0; i < response.data.professions.length; i++){
            if (i == 0){
              profession1Txt =response.data.professions[i].name
              profession1SkillTxt = response.data.professions[i].skill
            }
            else{
              profession2Txt = response.data.professions[i].name;
              profession2SkillTxt = response.data.professions[i].skill;
            }
          }

          var talent1Txt = "";
          var talent2Txt = "";

          for(i =0; i < response.data.talents.length; i++){
            if (i == 0) talent1Txt = response.data.talents[i].tree;
            else talent2Txt = response.data.talents[i].tree;
          }

          var member = {
            name: response.data.name,
            class: response.data.class,
            lvl: response.data.level,
            gs: gearscore,
            talentA: talent1Txt,
            talentB: talent2Txt,
            professionA: profession1Txt,
            skillA: profession1SkillTxt,
            professionB: profession2Txt,
            skillB: profession2SkillTxt
          };

          callback(member);
        }

      });

    })
    .catch(error => {
      console.log(error);
    });

}

/*** We get the entire guild roster from Warmane API */
var getRoster = async function (callback) {
  var tab = new Array();
  axios.get("https://armory.warmane.com/api/guild/" + guild + "/" + server + "/summary")
    .then(async response => {
      lastcall = Date.now();
      async.eachSeries(response.data.roster, function (item, callback) {

        setTimeout(function () {
          /*** Call to get each member's informations */
          getCharInfo(item.name, function (data) {
            console.log(data);
            tab.push(data);
            callback();
          });
        }, 3000 - (Date.now() - lastcall));

      }, function (err) {
        //console.log('iterating done');
        callback(tab);
      });
    })
    .catch(error => {
      console.log(error);
    });
}

/*** Roster initialization */
var start = Date.now();
getRoster(function (tab) {
  client.set("roster", JSON.stringify(tab));
  console.log("Parsing ended in : " + (Date.now()-start));
});

/*** The guild roster is updated every 6 hours */
new CronJob('10 0-23/6 * * *', function () {
  getRoster(function (tab) {
   client.set("roster", JSON.stringify(tab));
  });
}, null, true, 'Europe/Paris');


/*** http server to handle requests from gsheet */
http.createServer(async function (req, res) {
  var pathname = url.parse(req.url).pathname;
  if (pathname == "/"){
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    var response = await getAsync("roster");
    res.write(response);
    res.end();

  }else{
    console.log("Request for " + pathname.split("/").slice(1) + " received.");
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    var nom = pathname.split("/").slice(1);
    await setTimeout(async function () {
      var response = await getAsync(nom);
      if (response != null){
        res.write(response);
        res.end();
      }else{
        getCharInfo(nom, function (data) {
          client.set(nom, JSON.stringify(data),"EX",3600);
          res.write(JSON.stringify(data));
          res.end();
         
        });
      }
    }, 4000);
  }
  
}).listen(port);
