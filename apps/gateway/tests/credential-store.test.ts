/**
 * CredentialStore 测试:AES-256-GCM seal/open、篡改检测、key 校验。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { CredentialStore, CredentialStoreError } from '../src/credentials/credential-store.js'

const KEY = randomBytes(32).toString('hex')

test('seal/open: round-trips plaintext', () => {
  const store = new CredentialStore(KEY)
  const secret = 'super-secret-token-123'
  const envelope = store.seal(secret)
  assert.match(envelope, /^v1\./)
  assert.equal(store.open(envelope), secret)
})

test('seal: distinct nonces produce distinct envelopes', () => {
  const store = new CredentialStore(KEY)
  const a = store.seal('same')
  const b = store.seal('same')
  assert.notEqual(a, b)
  assert.equal(store.open(a), store.open(b))
})

test('open: tampered ciphertext rejected', () => {
  const store = new CredentialStore(KEY)
  const envelope = store.seal('secret')
  const parts = envelope.split('.')
  parts[3] = Buffer.from('tampered').toString('base64url')
  assert.throws(() => store.open(parts.join('.')), (e: unknown) => e instanceof CredentialStoreError)
})

test('open: wrong key rejected', () => {
  const store = new CredentialStore(KEY)
  const envelope = store.seal('secret')
  const other = new CredentialStore(randomBytes(32).toString('hex'))
  assert.throws(() => other.open(envelope))
})

test('constructor: invalid key rejected', () => {
  assert.throws(() => new CredentialStore('short'), (e: unknown) => e instanceof CredentialStoreError)
  assert.throws(() => new CredentialStore(''), (e: unknown) => e instanceof CredentialStoreError)
})

test('open: unsupported version rejected', () => {
  const store = new CredentialStore(KEY)
  assert.throws(() => store.open('v9.a.b.c'), (e: unknown) => e instanceof CredentialStoreError)
})