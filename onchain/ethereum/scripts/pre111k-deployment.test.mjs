import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentGas, matchingRuntime, PRE111K_SEPOLIA, validateDeploymentGasPrice, validateSignedDeployment } from './pre111k-deployment.mjs';

test('Sepolia deployment pins the approved immutable configuration', () => {
  assert.equal(PRE111K_SEPOLIA.chainId, 11155111);
  assert.equal(PRE111K_SEPOLIA.priceWei, '2300000000000000');
  assert.equal(PRE111K_SEPOLIA.treasury, '0x72d0c5623a05033f9ee4495d408bc6c05df8367d');
});

test('gas allowance uses live estimates, rounds up and enforces the fee ceiling', () => {
  assert.deepEqual(deploymentGas('100001', '1000'), {
    gasEstimate: '100001', gasLimit: '180002', gasPrice: '1500', maximumFeeWei: '270003000',
  });
  assert.equal(deploymentGas('100001', '20').gasPrice, '1000');
  assert.equal(deploymentGas('100001', '1001').gasPrice, '1502');
  assert.throws(() => deploymentGas('1', '1000000000000000000'), /fee ceiling/);
  assert.throws(() => deploymentGas('0', '1'), /Invalid/);
  assert.throws(() => deploymentGas('1', '0'), /Invalid/);
});

test('runtime comparison masks only declared immutable slots', () => {
  const references = { '1': [{ start: 2, length: 2 }] };
  assert.equal(matchingRuntime('0x112200005566', '0x1122aabb5566', references), true);
  assert.equal(matchingRuntime('0x112200005566', '0xff22aabb5566', references), false);
  assert.equal(matchingRuntime('0x112200005566', '0x1122aabb55', references), false);
  assert.equal(matchingRuntime('0x112200005566', '0x', references), false);
  assert.throws(() => matchingRuntime('0x1122', '0x1122', { '1': [{ start: 2, length: 1 }] }));
});

test('signing rejects a frozen offer below the current suggestion or either base fee', () => {
  const prepared = deploymentGas('6000000', '100000000');
  assert.equal(prepared.gasPrice, '150000000');
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '200000000', '190000000', '190000000'), /before signing/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '150000001', '100000000', '100000000'), /before signing/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', '150000001', '100000000'), /before signing/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', '100000000', '150000001'), /before signing/);
  validateDeploymentGasPrice(prepared.gasPrice, '150000000', '150000000', '150000000');
  validateDeploymentGasPrice(prepared.gasPrice, '0x5f5e100', '0x5f5e100', '0x5f5e100');
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', null, '100000000'), /fee data/);
  assert.throws(() => validateDeploymentGasPrice(prepared.gasPrice, '100000000', '100000000', undefined), /fee data/);
});

test('signed deployment cannot change network, recipient, payment, input or fee', () => {
  const manifest = { ...PRE111K_SEPOLIA, nonce: '57', gasPrice: '20', gasLimit: '7827455', creationCode: '0x60006000f3' };
  const transaction = { signer: manifest.admin, type: '0x0', chainId: '0xaa36a7', nonce: '0x39', gasPrice: '0x14',
    gas: '0x776fff', to: null, value: '0x0', input: manifest.creationCode, hash: '0x1234' };
  transaction.gas = '0x' + BigInt(manifest.gasLimit).toString(16);
  validateSignedDeployment(transaction, manifest, transaction.hash);
  for (const [key, value] of Object.entries({ signer: manifest.treasury, chainId: '0x1', nonce: '0x3a', gasPrice: '0x15',
    gas: '0x1000000', to: manifest.treasury, value: '0x1', input: '0x', hash: '0xffff' })) {
    assert.throws(() => validateSignedDeployment({ ...transaction, [key]: value }, manifest, transaction.hash));
  }
});
