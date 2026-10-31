export const PROOF = 'ipsasIndependentReview';
export const CASES = Object.freeze([
 'initial authoritative PPE', 'incompatible PPE classification is unknown',
 'PPE includes approved adjustment', 'grants tie includes approved adjustment',
 'canonical authority refuses invalidated source', 'PPE refuses invalidated source',
 'opening refuses invalidated source', 'grants refuse invalidated source',
 'grants period refuses invalidated source',
].map(label=>({id:label.toLowerCase().replaceAll(' ','-'),kind:'control',modes:['present']})));
