import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { checkContract } from '../packages/app/src/main/contract.js';
import { checkImplementation } from '../packages/app/src/main/implementation.js';
import { keepFrom, runCheck } from '../packages/runner/lib/check.js';

// Two servers on two ports, as a sign-in service and a site using it: the site sends a signed-out
// visitor to sign in with a state in the URL, the form carries it on HTML-escaped, and posting it
// sets a cookie the site then takes.
const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server)); });
let auth;
let site;
const portOf = (server) => server.address().port;

before(async () => {
  auth = await listen((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/login' && request.method === 'GET') {
      const state = url.searchParams.get('state');
      response.setHeader('content-type', 'text/html');
      return response.end(`<form><input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}"></form>`);
    }
    if (url.pathname === '/login' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      return request.on('end', () => {
        const form = new URLSearchParams(body);
        if (request.headers['content-type'] !== 'application/x-www-form-urlencoded' || form.get('password') !== 'right' || form.get('state') !== '{"to":"/home"}') { response.statusCode = 400; return response.end(); }
        response.statusCode = 302;
        response.setHeader('set-cookie', ['session=abc; Path=/; HttpOnly', 'old=1; Max-Age=0']);
        response.setHeader('location', '/home');
        response.end();
      });
    }
    response.statusCode = 404;
    response.end();
  });
  site = await listen((request, response) => {
    if ((request.headers.cookie ?? '').includes('session=abc')) { response.setHeader('content-type', 'application/json'); return response.end('{"signedIn":true}'); }
    response.statusCode = 302;
    response.setHeader('location', `http://localhost:${portOf(auth)}/login?state=${encodeURIComponent('{"to":"/home"}')}`);
    response.end();
  });
});
after(() => { auth.close(); site.close(); });

describe('a check through a sign-in', () => {
  test('keeps part of a header or HTML, decoded', () => {
    const response = { status: 302, headers: { location: '/login?state=%7B%22a%22%3A1%7D&x=1' }, body: '<input name="state" value="{&quot;a&quot;:1}">' };
    assert.equal(keepFrom(response, { from: 'headers.location', match: 'state=([^&]+)', decode: 'url' }), '{"a":1}');
    assert.equal(keepFrom(response, { from: 'body', match: 'value="([^"]*)"', decode: 'html' }), '{"a":1}');
    assert.equal(keepFrom(response, { from: 'body', match: 'nothing-(here)' }), undefined);
    assert.equal(keepFrom(response, 'status'), 302);
  });

  test('goes from one port to another, posts a form and carries the cookies it\'s given', async () => {
    const check = {
      key: 'signed-in/home',
      setup: [
        { id: 'visit', request: { method: 'GET', path: '/', port: portOf(site) }, expect: { status: 302 }, keep: { state: { from: 'headers.location', match: 'state=([^&]+)', decode: 'url' } } },
        { id: 'form', request: { method: 'GET', path: '/login', query: { state: '{state}' } }, keep: { form_state: { from: 'body', match: 'name="state" value="([^"]*)"', decode: 'html' } } },
        { id: 'sign-in', request: { method: 'POST', path: '/login', form: { password: 'right', state: '{form_state}' } }, expect: { status: 302, headers: { location: '/home' } } },
      ],
      request: { method: 'GET', path: '/', port: portOf(site) },
      expect: { status: 200, body: { signedIn: true } },
    };
    const result = await runCheck(check, { base: `http://127.0.0.1:${portOf(auth)}` });
    assert.equal(result.outcome, 'passed', result.detail);
    // A wrong password stops the setup, saying so; a match not found too.
    const wrong = structuredClone(check);
    wrong.setup[2].request.form.password = 'wrong';
    assert.match((await runCheck(wrong, { base: `http://127.0.0.1:${portOf(auth)}` })).detail, /Setup sign-in didn't work.*Expected status 302, got 400/);
    const missing = structuredClone(check);
    missing.setup[1].keep.form_state.match = 'name="nonce" value="([^"]*)"';
    assert.match((await runCheck(missing, { base: `http://127.0.0.1:${portOf(auth)}` })).detail, /Setup form's body has nothing matching/);
  });

  test('the contract and implementation say what\'s wrong with them', () => {
    const contract = (step, request = { method: 'GET', path: '/' }) => ({ children: [{ id: 'n', name: '/', setup: [{ id: 's', kind: 'http', request: { method: 'GET', path: '/' }, ...step }], clauses: [{ id: 'c', title: 'T', checks: [{ id: 'k', kind: 'http', request, expect: { status: 200 } }] }] }] });
    assert.doesNotThrow(() => checkContract(contract({ keep: { state: { from: 'headers.location', match: 'state=([^&]+)', decode: 'url' } } }, { method: 'POST', path: '/', port: 9020, form: { state: '{state}' } })));
    assert.throws(() => checkContract(contract({ keep: { state: { from: 'location' } } })), /starting body\., headers\. or status/);
    assert.throws(() => checkContract(contract({ keep: { state: { from: 'body', match: '(' } } })), /isn't a regular expression/);
    assert.throws(() => checkContract(contract({ keep: { state: { from: 'body', decode: 'base64' } } })), /decode is url or html/);
    assert.throws(() => checkContract(contract({}, { method: 'POST', path: '/', form: { a: 'b' }, body: {} })), /a body and a form/);
    assert.throws(() => checkContract(contract({}, { method: 'GET', path: '/', port: 0 })), /port should be a port number/);
    const stack = { source: { kind: 'compose', url: 'https://github.com/larder/stack.git', service: 'orders' }, start: { port: 3000, after: ['bash script/seed.sh'] } };
    assert.doesNotThrow(() => checkImplementation(stack));
    assert.throws(() => checkImplementation({ source: { kind: 'image', image: 'x:1' }, start: { port: 1, after: ['x'] } }), /no folder of code/);
  });
});
