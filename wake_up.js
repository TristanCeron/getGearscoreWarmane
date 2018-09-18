const axios = require('axios');

var myURL = process.env.My_URL;

axios.get(myURL)
  .then(async response => {
      console.log("Wake up!");
  })
  .catch(error => {
    console.log(error);
});
