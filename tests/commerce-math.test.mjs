import assert from 'node:assert/strict';
import {test} from 'node:test';
import {moneyCents, suggestedRetailCents, buildCjFreightTrial, parseCjFreightTrial} from '../src/commerce-math.js';

test('parses money exactly to cents, never silently truncates', () => {
  assert.equal(moneyCents('101.57'), 10157);
  assert.equal(moneyCents(0.1), 10);
  for (const value of ['1.999', '-1', 'NaN', 2.999, '', '1e3', null, {}]) assert.equal(moneyCents(value), null);
});
test('suggested price depends on explicit margin, fee, freight and risk policy', () => {
  const cents = suggestedRetailCents({supplierCostCents:10000, freightCents:1500,
    processingFixedCents:30, processingVariableBps:349,
    targetMarginBps:3000, riskBufferCents:300});
  assert.equal(cents, Math.ceil(11830 * 10000 / (10000 - 349 - 3000)));
  assert.equal(suggestedRetailCents({supplierCostCents:10000, freightCents:null,
    processingFixedCents:30, processingVariableBps:349, targetMarginBps:3000, riskBufferCents:300}),null);
  assert.equal(suggestedRetailCents({supplierCostCents:1, freightCents:1,
    processingFixedCents:1, processingVariableBps:8000, targetMarginBps:3000, riskBufferCents:1}),null);
});
test('CJ shipping request requires verified origin and a U.S. ZIP', () => {
  const sample={originCountryCode:'US', destinationZip:'10001', items:[{vid:'A1234-B5678',quantity:2}]};
  assert.deepEqual(buildCjFreightTrial(sample), {startCountryCode:'US',endCountryCode:'US',zip:'10001',products:sample.items});
  assert.equal(buildCjFreightTrial({...sample,originCountryCode:null}),null);
  assert.equal(buildCjFreightTrial({...sample,destinationZip:'10001;DROP'}),null);
  assert.equal(buildCjFreightTrial({...sample,items:[sample.items[0],sample.items[0]]}),null);
});
test('CJ freight response is explicitly estimated and retains no credentials', () => {
  const options=parseCjFreightTrial({result:true,code:200,data:[{logisticName:'USPS+',logisticPrice:4.71,logisticAging:'2-5'}]});
  assert.deepEqual(options,[{carrier:'USPS+',estimatedFreightCents:471,deliveryEstimate:'2-5',preliminary:true}]);
  assert.deepEqual(parseCjFreightTrial({code:400,result:false,data:[{logisticName:'USPS+',logisticPrice:0}]}),[]);
  assert.deepEqual(parseCjFreightTrial({result:true,code:200,data:[{logisticName:'x',logisticPrice:'not a number'}]}),[]);
});
