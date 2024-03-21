//server
import {WebSocketServer} from 'ws'
import {promises as fs} from 'fs'
import {createServer} from 'https'
import sha256 from 'sha256'
import fsExists from 'fs.promises.exists';
import fetch from 'node-fetch';
let SECURE = false
let BOARD, CHANGES

//TODO: compress changes
const WIDTH = 2000, HEIGHT = 2000, PALETTE_SIZE = 32, COOLDOWN = 10e3 //5mins
try{
	BOARD = await fs.readFile('./place')
	CHANGES = new Uint8Array(WIDTH * HEIGHT).fill(255)
}catch(e){
	BOARD = new Uint8Array(WIDTH * HEIGHT)
	CHANGES = new Uint8Array(WIDTH * HEIGHT).fill(255)
}
let newPos = [], newCols = []
let wss, cooldowns = new Map()

function runLengthChanges(){
	//compress CHANGES with run-length encoding
	let i = 0
	let bufs = [Buffer.alloc(256)], blast = 0, bi = 0
	bufs[0][bi++] = 2
	let add = a => {bufs[blast][bi++]=a;bi==256&&(bi=0,bufs.push(Buffer.alloc(256)),blast++)}
	while(true){
		let c = 0
		while(CHANGES[i] == 255)c++,i++
		if(i == CHANGES.length)break
		//c is # of blank cells
		//we will borrow 2 bits to store the blank cell count
		//00 = no gap
		//01 = 1-byte (Gaps up to 255)
		//10 = 2-byte	(Gaps up to 65535)
		//11 = 4-byte (idk probs never used)
		if(c < 256){
			if(!c)add(CHANGES[i++])
			else{
				add(CHANGES[i++] + 64)
				add(c)
			}
		}else if(c < 65536){
			add(CHANGES[i++] + 128)
			add(c >> 8)
			add(c)
		}else{
			add(CHANGES[i++] + 192)
			add(c >> 24)
			add(c >> 16)
			add(c >> 8)
			add(c)
		}
	}
	bufs[blast] = bufs[blast].slice(0,bi)
	return Buffer.concat(bufs)
}
const PORT = 1292
if(SECURE){
	wss = new WebSocketServer({ server: createServer({cert: await fs.readFile('/www/server/panel/vhost/ssl/superjovie.xyz/fullchain.pem'),
	key: await fs.readFile('/www/server/panel/vhost/ssl/superjovie.xyz/privkey.pem') }).listen(1292) })
}else wss = new WebSocketServer({ port: 1292 })

if (!await fsExists('blacklist.txt')) {
	await fs.writeFile("blacklist.txt", "", err => { if (err) { console.error(err); return; } });
}
if (!await fsExists('cooldown_overrides.txt')) {
	await fs.writeFile("cooldown_overrides.txt", "", err => { if (err) { console.error(err); return; } });
}
if (!await fsExists('vip.txt')) {
	await fs.writeFile("vip.txt", "", err => { if (err) { console.error(err); return; } });
}
if (!await fsExists("webhook_url.txt")) {
  await fs.writeFile("webhook_url.txt", "", err => { if (err) { console.error(err); return; } });
}

let players = 0
let VIP
try{VIP = new Set((await fs.readFile('vip.txt')).toString().split('\n'))}catch(e){}
let BANS = new Set(await fs.readFile('blacklist.txt').toString().split('\n'))
let OVERRIDES = new Set(['::ffff:43.132.177.209','::ffff:110.189.121.62'])
let WEBHOOK_URL = (await fs.readFile("webhook_url.txt")).toString()

let hash = a => a.split("").reduce((a,b)=>(a*31+b.charCodeAt())>>>0,0)
let allowed = new Set("rplace.tk google.com wikipedia.org pxls.space".split(" ")), censor = a => a.replace(/fuc?k|shi[t]|c[u]nt/gi,a=>"*".repeat(a.length)).replace(/https?:\/\/(\w+\.)+\w{2,15}(\/\S*)?|(\w+\.)+\w{2,15}\/\S*|(\w+\.)+(tk|ga|gg|gq|cf|ml|fun|xxx|webcam|sexy?|tube|cam|p[o]rn|adult|com|net|org|online|ru|co|info|link)/gi, a => allowed.has(a.replace(/^https?:\/\//,"").split("/")[0]) ? a : "").trim()

let decoder = new TextDecoder();

wss.on('connection', async function(p, {headers, url: uri}) {
	let url = uri.slice(1)
	let IP = p._socket.remoteAddress //url || headers['x-forwarded-for']
	if(url && !VIP.has(sha256(IP)))return p.close()
	let CD = url ? (url.startsWith('!') ? 0 : COOLDOWN / 2) : COOLDOWN
	if(!IP)return p.close()
	p.lchat = 0
	let buf = Buffer.alloc(5)
	buf[0] = 1
	buf.writeInt32BE(Math.ceil(cooldowns.get(IP) / 1000) || 1, 1)
	p.send(buf)
	players++
	p.send(runLengthChanges())
  p.on("error", _=>_)
  p.on('message', async function(data) {
		if(data[0] == 15){
			if(p.lchat + 2500 > NOW || data.length > 400)return
			p.lchat = NOW
			for(let c of wss.clients) {
                c.send(data)
			}
			return
		}
		if(data.length < 6)return //bad packet
		let i = data.readInt32BE(1), c = data[5]
		if(i >= BOARD.length || c >= PALETTE_SIZE)return //bad packet
        let cd = cooldowns.get(IP)
		if(cd > NOW){
			//reject
			let data = Buffer.alloc(10)
			data[0] = 7
			data.writeInt32BE(Math.ceil(cd / 1000) || 1, 1)
			data.writeInt32BE(i, 5)
			data[9] = CHANGES[i] == 255 ? BOARD[i] : CHANGES[i]
			p.send(data)
			return
		}
		//accept
		CHANGES[i] = c
		cooldowns.set(IP, NOW + CD - 1000)
		newPos.push(i)
		newCols.push(c)
  })
	p.on('close', function(){ players-- })
})
let NOW = Date.now()
setInterval(() => {
	NOW = Date.now()
}, 50)

import { exec } from 'child_process'

//let ORIGIN = (''+await fs.readFile("../.git-credentials")).trim()

async function pushImage(){
	//await new Promise((r, t) => exec("git add *;git commit -a -m 'Hourly backup';git push --force "+ORIGIN+"/rslashplace2/rslashplace2.github.io", e => e ? t(e) : r()))
	//serve old changes for 11 more mins just to be 100% safe
	let curr = new Uint8Array(CHANGES)
	setTimeout(() => {
		//after 11 minutes, remove all old changes. Where there is a new change, curr[i] != CHANGES[i] and so it will be kept, but otherwise, remove
		for(let i = curr.length - 1; i >= 0; i--)if(curr[i] == CHANGES[i])CHANGES[i] = 255
	}, 660e3)
}
setInterval(function(){
	if(!newPos.length)return
	let pos
	let buf = Buffer.alloc(1 + newPos.length * 5)
	buf[0] = 6
	let i = 1
	while((pos = newPos.pop()) != undefined){
		buf.writeInt32BE(pos, i)
		i += 4
		buf[i++] = newCols.pop()
	}
	for(let c of wss.clients){
		c.send(buf)
	}
}, 1000)

let I = 0

setInterval(async function(){
	I++
	for (let i = BOARD.length-1; i >= 0; i--)if(CHANGES[i]!=255)BOARD[i] = CHANGES[i]
	await fs.writeFile('place', BOARD)
	let buf = Buffer.of(3, players>>8, players)
	for (let c of wss.clients) {
		c.send(buf)
	}
	if(I % 720 == 0){
		try {
                	await pushImage()
                	console.log("["+new Date().toISOString()+"] Successfully saved r/place!")
        	} catch(e) {
                	console.log("["+new Date().toISOString()+"] Error pushing image")
        	}
        	for (let [k, t] of cooldowns) {
                	if(t > NOW)cooldowns.delete(k)
        	}
	}
}, 5000)

import repl from 'basic-repl'

let a, b, c, test
repl('$',(_)=>eval(_))
let O=()=>{console.log("\x1b[31mNothing to confirm!")}, yc = O;
Object.defineProperties(globalThis, {y: {get(){yc();yc=O}}, n: {get(){yc=O}}})
function fill(x, y, x1, y1, b = 27, random = false) {
	let w = x1-x, h = y1-y
	for(;y < y1; y++){
		for(;x < x1; x++){
			CHANGES[x + y * WIDTH] = random ? Math.floor(Math.random() * 24) :  b
		}
		x = x1 - w
	}
	return `Filled an area of ${w}*${h} (${(w*h)} pixels), reload the webpage to see the effects`
}
