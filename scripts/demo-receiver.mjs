import {createServer} from 'node:http';
// Synthetic sink only: never calls a model or a business tool, never prints Pack bodies.
createServer(async(req,res)=>{
 if(req.method!=='POST'||req.url!=='/model'){res.writeHead(404);res.end();return;}
 let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>262144){res.writeHead(413);res.end();return;}}
 console.log(JSON.stringify({received:true,bytes:size,businessActionExecuted:false}));
 res.writeHead(200,{'content-type':'application/json'});res.end('{"acknowledged":true}');
}).listen(3641,'127.0.0.1',()=>console.log('Synthetic consumer ready at http://127.0.0.1:3641/model'));
