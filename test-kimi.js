async function test() {
  const res = await fetch('https://api.kimi.com/coding/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer sk-kimi-Pw1ugRWpLJulDeF4spAqbMRo7evKdFc95adI8dwtpc6az1fWgVUM3oqiYSlJWEMI',
      'Content-Type': 'application/json',
      'X-Use-Cache': 'true'
    },
    body: JSON.stringify({
      model: 'K2.6',
      messages: [{role: 'user', content: 'hi'}]
    })
  });
  console.log(res.status);
  console.log(await res.text());
  console.log(Object.fromEntries(res.headers.entries()));
}
test();
