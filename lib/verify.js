/*!
 * Copyright (c) 2023 Digital Bazaar, Inc. All rights reserved.
 */
import * as base58 from 'base58-universal';
import * as EcdsaMultikey from '@digitalbazaar/ecdsa-multikey';
import {
  hashCanonizedProof, hashMandatory, hmacIdCanonize
} from './di-sd-primitives/index.js';
import {
  parseDisclosureProofValue, serializeBaseVerifyData
} from './proofValue.js';
import {name} from './name.js';
import {requiredAlgorithm} from './requiredAlgorithm.js';

export function createVerifyCryptosuite() {
  return {
    name,
    requiredAlgorithm,
    createVerifier,
    createVerifyData: _createVerifyData
  };
}

export async function createVerifier({verificationMethod}) {
  const key = await EcdsaMultikey.from(verificationMethod);
  const verifier = key.verifier();
  return {
    algorithm: verifier.algorithm,
    id: verifier.id,
    // `data` includes `signature` in this cryptosuite
    async verify({data}) {
      return _multiverify({verifier, data});
    }
  };
}

async function _createVerifyData({
  cryptosuite, document, proof, documentLoader
}) {
  if(cryptosuite?.name !== name) {
    throw new TypeError(`"cryptosuite.name" must be "${name}".`);
  }

  // Verify derived proof needs:
  // 1. canonized with hmac'd labels + mandatory message indexes + message
  //    index map => mandatory quads + SD quads (drop any overlap from SD quads)
  // 2. hash mandatory quads in order => mandatory hash
  // 3. verify SD quads
  // 4. verify main signature (includes mandatory quads verification)

  // 1. Generate `proofHash` in parallel.
  const options = {documentLoader};
  const proofHashPromise = hashCanonizedProof({document, proof, options})
    .catch(e => e);

  // 2. Parse disclosure `proof` to get parameters to verify.
  const {
    baseSignature, publicKey, signatures, labelMap, mandatoryIndexes
  } = await parseDisclosureProofValue({proof});

  // 3. HMAC IDs in canonized document using given label map.
  const nquads = await hmacIdCanonize({document, options, labelMap});

  // 4. Separate N-Quads into mandatory and non-mandatory.
  const mandatory = [];
  const nonMandatory = [];
  for(const [index, nq] of nquads) {
    if(mandatoryIndexes.includes(index)) {
      mandatory.push(nq);
    } else {
      nonMandatory.push(nq);
    }
  }

  // 5. Hash any mandatory N-Quads.
  let mandatoryHash;
  if(mandatory.length > 0) {
    ({mandatoryHash} = await hashMandatory({mandatory}));
  }

  // 6. Return data used by cryptosuite to verify.
  const proofHash = await proofHashPromise;
  if(proofHash instanceof Error) {
    throw proofHash;
  }
  return {
    baseSignature, proofHash, publicKey, signatures, nonMandatory,
    mandatoryHash
  };
}

async function _multiverify({verifier, data} = {}) {
  const {
    baseSignature, proofHash, publicKey, signatures,
    nonMandatory, mandatoryHash
  } = data;

  // 1. Import `publicKey`.
  const publicKeyMultibase = base58.encode(publicKey);
  const localKeyPair = await EcdsaMultikey.from({publicKeyMultibase});

  // 2. Verify all signatures.
  if(signatures.length !== nonMandatory.length) {
    // FIXME: bikeshed error text
    throw new Error(
      'Signature count does not match non-mandatory message count.');
  }
  const {verify} = localKeyPair.verifier();
  const results = await Promise.all(signatures.map(
    (signature, index) => verify({data: nonMandatory[index], signature})));
  // check results
  for(const {verified, error} of results) {
    // FIXME: bikeshed
    if(!verified) {
      throw error;
    }
  }

  const toVerify = await serializeBaseVerifyData(
    {proofHash, publicKey, mandatoryHash});
  return verifier.verify({data: toVerify, signature: baseSignature});
}