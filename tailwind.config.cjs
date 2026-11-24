const sharedConfig = require('./js/tailwind-config.js');

module.exports = {
  ...sharedConfig,
  content: ['./index.html', './js/**/*.js']
};
