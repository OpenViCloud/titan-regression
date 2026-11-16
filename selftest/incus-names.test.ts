// Run: node --test 'selftest/*.test.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { incusName, phase4Key, projectOf } from '../lib/incus-names.ts'

test('a name is the prefix and 26 base32 letters of the 16 bytes of the id', () => {
  assert.equal(incusName('vm', '00000000-0000-0000-0000-000000000000'), 'vm' + 'a'.repeat(26))
  // 0xff… : 25 letters of 31 and the last 3 bits padded with two zeros (0b11100 = 28 = '4')
  assert.equal(incusName('bk', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), 'bk' + '7'.repeat(25) + '4')
  assert.equal(incusName('vol', '01000000-0000-0000-0000-000000000000'), 'vol' + 'ae' + 'a'.repeat(24))
})

test('the project of a tenant is t- and the id without dashes', () => {
  assert.equal(projectOf('ba35a53b-214c-40e0-8a59-a12dd29b4d47'), 't-ba35a53b214c40e08a59a12dd29b4d47')
})

test('a key comes from the env and only as one public key line', () => {
  assert.equal(phase4Key('V', { PHASE4_KEY_V: 'ssh-ed25519 AAAAC3x rg-p4-v\n' }), 'ssh-ed25519 AAAAC3x rg-p4-v')
  assert.throws(() => phase4Key('U', {}), /PHASE4_KEY_U .*REGRESSION_PHASE4_KEYS/)
  assert.throws(() => phase4Key('V', { PHASE4_KEY_V: '-----BEGIN OPENSSH PRIVATE KEY-----' }), /PHASE4_KEY_V/)
  assert.throws(() => phase4Key('V', { PHASE4_KEY_V: 'ssh-ed25519 AAAAa a\nssh-ed25519 AAAAb b' }), /PHASE4_KEY_V/)
})
