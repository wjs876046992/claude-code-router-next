const http = require('http');

const req = http.request({
  hostname: '127.0.0.html', // wait, localhost
  port: 3000, // or 8080?
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-provider': 'openai'
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Response:', data));
});
req.write(JSON.stringify({
  model: 'gpt-4',
  messages: [{role: 'user', content: 'hello'}]
}));
req.end();
