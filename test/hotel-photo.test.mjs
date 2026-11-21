import assert from 'node:assert/strict';
import test from 'node:test';
import { hotelPageDetails } from '../server/photos.mjs';

const identity = { name:'Premier Inn London County Hall' };
const page = 'https://hotel.example/london/county-hall';
const head = '<head><title>Premier Inn London County Hall</title><meta property="og:site_name" content="Premier Inn">' +
  '<meta property="og:image" content="https://hotel.example/websites/facebook-twitter/premierinn-ogimage.jpg"></head>';

test('a branch-specific exterior wins over a chain sharing card and unrelated hotel images', () => {
  const photo = hotelPageDetails(head + '<img alt="Exterior at Premier Inn London Blackfriars" src="/blackfriars.jpg">' +
    '<img src="/_next/image?url=%2Fhotelimages%2FLONCOU%201.jpg&amp;w=800" alt="Exterior at Premier Inn London County Hall">', page, identity).photo;
  assert.equal(photo.url,'https://hotel.example/_next/image?url=%2Fhotelimages%2FLONCOU%201.jpg&w=800');
  assert.equal(photo.credit,'Premier Inn');
  assert.equal(photo.page,page);
  assert.equal(hotelPageDetails(head, page, identity).photo,undefined);
});

test('a multi-property listing returns only the selected hotel’s structured photo and coordinates', () => {
  const schema = {'@graph':[
    {'@type':'Hotel', name:'Premier Inn London Blackfriars', image:'https://hotel.example/wrong.jpg', geo:{latitude:51.511,longitude:-.103}},
    {'@type':'Hotel', name:identity.name, image:[{'@type':'ImageObject',contentUrl:'/county-hall.jpg'}], geo:{latitude:'51.501',longitude:'-.118'}},
  ]};
  const doc = '<script type="application/ld+json">'+JSON.stringify(schema)+'</script>';
  const details = hotelPageDetails(doc,page,identity);
  assert.equal(details.named,true);
  assert.deepEqual(details.ll,[51.501,-.118]);
  assert.equal(details.photo.url,'https://hotel.example/county-hall.jpg');
  assert.deepEqual(hotelPageDetails(doc,page,{name:'Missing Hotel'}),{named:false});
});
