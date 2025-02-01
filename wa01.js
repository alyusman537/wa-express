// load in the environment vars
require("dotenv").config({ silent: true });
const db = require('./db.js')
const { v4: uuidv4 } = require('uuid');

const Boom = require('@hapi/boom')
const NodeCache = require('node-cache')
const readline = require('readline')
const {
	makeWASocket, AnyMessageContent, BinaryInfo, delay, DisconnectReason, downloadAndProcessHistorySyncNotification, encodeWAM, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, getHistoryMsg, isJidNewsletter, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey
} = require('@whiskeysockets/baileys')
const fs = require('fs')
const P = require('pino')
const express = require("express");
const bodyParser = require("body-parser");
const loggerMorgan = require("morgan");

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

const msgRetryCounterCache = new NodeCache()

const onDemandMap = null;//new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise < string > ((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		mobile: useMobile,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage,
	})

	store?.bind(sock.ev)

	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		if (useMobile) {
			throw new Error('Cannot use pairing code with mobile api')
		}

		const phoneNumber = await question('Please enter your mobile phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	// If mobile was chosen, ask for the code
	if (useMobile && !sock.authState.creds.registered) {
		const { registration } = sock.authState.creds || { registration: {} }

		if (!registration.phoneNumber) {
			registration.phoneNumber = await question('Please enter your mobile phone number:\n')
		}

		const libPhonenumber = await import("libphonenumber-js")
		const phoneNumber = libPhonenumber.parsePhoneNumber(registration.phoneNumber)
		if (!phoneNumber?.isValid()) {
			throw new Error('Invalid phone number: ' + registration.phoneNumber)
		}

		registration.phoneNumber = phoneNumber.format('E.164')
		registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
		registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
		const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
		if (!mcc) {
			throw new Error('Could not find MCC for phone number: ' + registration.phoneNumber + '\nPlease specify the MCC manually.')
		}

		registration.phoneNumberMobileCountryCode = mcc

		async function enterCode() {
			try {
				const code = await question('Please enter the one time code:\n')
				const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
				console.log('Successfully registered your phone number.')
				console.log(response)
				rl.close()
			} catch (error) {
				console.error('Failed to register your phone number. Please try again.\n', error)
				await askForOTP()
			}
		}

		async function enterCaptcha() {
			const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
			const path = __dirname + '/captcha.png'
			fs.writeFileSync(path, Buffer.from(response.image_blob, 'base64'))

			open(path)
			const code = await question('Please enter the captcha code:\n')
			fs.unlinkSync(path)
			registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
		}

		async function askForOTP() {
			if (!registration.method) {
				await delay(2000)
				let code = await question('How would you like to receive the one time code for registration? "sms" or "voice"\n')
				code = code.replace(/["']/g, '').trim().toLowerCase()
				if (code !== 'sms' && code !== 'voice') {
					return await askForOTP()
				}

				registration.method = code
			}

			try {
				await sock.requestRegistrationCode(registration)
				await enterCode()
			} catch (error) {
				console.error('Failed to request registration code. Please try again.\n', error)

				if (error?.reason === 'code_checkpoint') {
					await enterCaptcha()
				}

				await askForOTP()
			}
		}

		askForOTP()
	}

	const sendMessageWTyping = async (msg, jid) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async (events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if (connection === 'close') {
					// reconnect if not logged out
					if ((lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')

						const filePath = './baileys_store_multi.json'; // Replace with the actual path to your file
						const folderPath = './baileys_auth_info'; // Replace with the actual path to your file
						// Remove the file
						fs.unlink(filePath, (err) => {
							if (err) {
								console.error(`Error removing file: ${err}`);
								// return;
							}
							console.log(`File ${filePath} has been successfully removed.`);
						});

						fs.rm(folderPath, { recursive: true, force: true }, err => {
							if (err) {
								console.error(`Error removing file: ${err}`);
								fs.mkdirSync(folderPath)
								// return;
							}
							console.log(`${folderPath} is deleted!`);
						});
						startSock()
					}

				}

				// WARNING: THIS WILL SEND A WAM EXAMPLE AND THIS IS A ****CAPTURED MESSAGE.****
				// DO NOT ACTUALLY ENABLE THIS UNLESS YOU MODIFIED THE FILE.JSON!!!!!
				// THE ANALYTICS IN THE FILE ARE OLD. DO NOT USE THEM.
				// YOUR APP SHOULD HAVE GLOBALS AND ANALYTICS ACCURATE TO TIME, DATE AND THE SESSION
				// THIS FILE.JSON APPROACH IS JUST AN APPROACH I USED, BE FREE TO DO THIS IN ANOTHER WAY.
				// THE FIRST EVENT CONTAINS THE CONSTANT GLOBALS, EXCEPT THE seqenceNumber(in the event) and commitTime
				// THIS INCLUDES STUFF LIKE ocVersion WHICH IS CRUCIAL FOR THE PREVENTION OF THE WARNING
				const sendWAMExample = false;
				if (connection === 'open' && sendWAMExample) {
					/// sending WAM EXAMPLE
					const {
						header: {
							wamVersion,
							eventSequenceNumber,
						},
						events,
					} = JSON.parse(await fs.promises.readFile("./boot_analytics_test.json", "utf-8"))

					const binaryInfo = new BinaryInfo({
						protocolVersion: wamVersion,
						sequence: eventSequenceNumber,
						events: events
					})

					const buffer = encodeWAM(binaryInfo);

					const result = await sock.sendWAMBuffer(buffer)
					console.log(result)
				}

				console.log('connection update :', update)
				console.log('connection update 123 :', update.connection)
				/*if (update.connection == "close") {
					const filePath = './baileys_store_multi.json'; // Replace with the actual path to your file
					const folderPath = './baileys_auth_info'; // Replace with the actual path to your file
					// Remove the file
					fs.unlink(filePath, (err) => {
						if (err) {
							console.error(`Error removing file: ${err}`);
							// return;
						}
						console.log(`File ${filePath} has been successfully removed.`);
					});

					fs.rm(folderPath, { recursive: true, force: true }, err => {
						if (err) {
							console.error(`Error removing file: ${err}`);
							fs.mkdirSync(folderPath)
							// return;
						}
						console.log(`${folderPath} is deleted!`);
					  });

					  startSock()
				} */
			}

			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
			}

			// if(events['labels.association']) {
			// 	console.log(events['labels.association'])
			// }


			// if(events['labels.edit']) {
			// 	console.log(events['labels.edit'])
			// }

			// if(events.call) {
			// 	console.log('recv call event', events.call)
			// }

			// history received
			/* if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					console.log('received on-demand history sync, messages=', messages)
				}
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			} */

		}
	)

	return sock

	async function getMessage(key) {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid, key.id)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}

startSock()

const app = express();
// const http = require("http")
// const server = http.createServer(app)
// const { Server, Socket } = require("socket.io")
// const io = new Server(server)


// io.on("connenction", socket => {
// 	console.log("socket terkoneksi");
// })
const port = process.env.PORT || 3000;
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


//logger
app.use(loggerMorgan("dev"));
// urusan cors
app.use(function (req, res, next) {
	res.header("Access-Control-Allow-Origin", "*");
	res.header(
		"Access-Control-Allow-Headers",
		"Origin, X-Requested-With, Content-Type, Accept, API-Key"
	);
	next();
});

const infoMessage = (req, res) => {
	try {
		return res.status(200).json({
			status: "OK",
			pesan: {
				info: {
					url: "/",
					method: "get",
					keterangan: "informasi menganai API WA",
				},
				// cek_nomor: {
				// 	url: "/cek",
				// 	params: "nomor_telepon",
				// 	method: "get",
				// 	keterangan: "untuk cek apakah nomor tersebuk aktif di WA atau tidak",
				// },
				kirim_pesan: {
					url: "/pesan",
					method: "post",
					body: {
						nomor: "Harus diisi",
						pesan: "Harus diisi"
					}
				},
				kirim_otp: {
					url: "/otp",
					method: "post",
					body: {
						nomor: "Harus diisi",
						judul: "Harus diisi",
						otp: "Harus diisi",
						pesan: "Harus diisi"
					}
				},
			},
		});
	} catch (error) {
		return res.status(400).json({
			status: "ERROR",
			pesan: error.message,
		});
	}
};

/*const cekWa = async (req, res) => {
  try {
	const nomor = req.params["nomor"];
	let data = new FormData();
	data.append("target", nomor);
	data.append("countryCode", "62");
	const hasil = await fetch("https://api.fonnte.com/validate", {
	  method: "POST",
	  mode: "cors",
	  headers: new Headers({
		Authorization: process.env.FONNTE_TOKEN,
	  }),
	  body: data,
	});

	const result = await hasil.json();
	if (result.not_registered[0]) {
	  return res.status(400).json({
		status: "NOT OK",
		pesan: `Nomor ${result.not_registered[0]} tidak terdaftar di WA`,
	  });
	} else {
	  return res.status(200).json({
		status: "OK",
		pesan: `Nomor ${result.registered[0]} aktif di WA`,
	  });
	}
  } catch (error) {
	return res.status(400).json({
	  status: "ERROR",
	  hasil: error.message,
	});
  }
};*/

const sendPesan = async (req, res) => {
	try {
		let hp = req.body.nomor;
		let pesan = req.body.pesan;
		const nomorTerakhir = Math.floor(parseInt(hp.charAt(hp.length - 1)) / 2)

		let delay = nomorTerakhir === 0 ? 2000 : nomorTerakhir * 1000;

		if (!pesan || !hp) {
			return res.status(400).json({
				status: "ERROR",
				messages: "Nomor WA dan isi pesan tidak boleh kosong",
			});
		}
		let jadi = "";
		if (hp.substring(0, 2) == "08") {
			jadi = `62${hp.substring(1)}`;
		} else if (hp.substring(0, 2) == "62") {
			jadi = hp;
		}
		// const id = jadi + "@s.whatsapp.net"; // the WhatsApp ID
		const uid = uuidv4()
		const formatPesan = req.body.pesan + "\n\n> `Dikirim oleh BMT Maslahah`\n" + uid
		const prosesKirimWa = setTimeout(() => kirimDanSimpan(jadi, formatPesan, uid).then((response) => {
			return res.status(200).json({
				status: "SUCCESS",
				// fungsi: "kirimDanSimpan",
				// messages1: response,
				uuid: uid,
				messages: {
					id: response.key.id,
					nomor: String(response.key.remoteJid).split('@')[0],
					text: response.message.extendedTextMessage.text,
					terkirim: response.message.status
				},
			});
		}), delay)

		// let send_message =  setTimeout( async () => await sock.sendMessage(id, { text: formatPesan }), delay); //sendMessageWTyping
		// // let send_message = await sendMessageWTyping({ text: req.body.pesan }, id); //sendMessageWTyping
		// simpanPesanToMysql({
		// 	nomor: jadi, 
		// 	pesan: formatPesan,
		// 	message_id: send_message.key.id
		// })
		// return res.status(200).json({
		//   status: "ok",
		//   message_id: send_message.key.id,
		//   penerima: id,
		//   pesan: send_message.message.extendedTextMessage.text,
		// });
	} catch (error) {
		return res.status(400).json({
			status: "ERROR",
			fungsi: "sendPesan",
			messages: error.message,
		});
	}
};

async function kirimDanSimpan(jadi, pesan, uid) {
	const id = jadi + "@s.whatsapp.net"; // the WhatsApp ID
	try {
		let send_message = await sock.sendMessage(id, { text: pesan }); //sendMessageWTyping
		// let send_message = await sendMessageWTyping({ text: req.body.pesan }, id); //sendMessageWTyping
		simpanPesanToMysql({
			uuid: uid,
			nomor: jadi,
			pesan: pesan,
			message_id: send_message.key.id
		})
		return send_message
	} catch (error) {
		return error
	}

}

const sendOtp = async (req, res) => {
	try {
		let hp = req.body.nomor;
		let pesan = req.body.pesan;
		let otp = req.body.otp;
		let judul = String(req.body.judul).toUpperCase();

		const nomorTerakhir = Math.floor(parseInt(hp.charAt(hp.length - 1)) / 2)

		let delay = nomorTerakhir === 0 ? 2000 : nomorTerakhir * 1000;

		if (!hp || !pesan || !otp || !judul) {
			return res.status(400).json({
				status: "ERROR",
				messages: {
					nomor: "Field nomor wa tidak boleh kosong",
					judul: "Field judul tidak boleh kosong",
					otp: "Field otp tidak boleh kosong",
					pesan: "Field pesan tidak boleh kosong",
				}
			});
		}

		let jadi = "";
		if (hp.substring(0, 2) == "08") {
			jadi = `62${hp.substring(1)}`;
		} else if (hp.substring(0, 2) == "62") {
			jadi = hp;
		} else {
			return res.status(400).json({
				status: "ERROR",
				messages: "Nomor wa yang anda masukkan tidak valid. Mohon periksa kembali"
			})
		}
		// const id = jadi + "@s.whatsapp.net"; // the WhatsApp ID
		const uid = uuidv4()
		const formatOtp = "*" + judul + "*\n> *`" + otp + "`*\n\n" + pesan + "\n\n> `Dikirim oleh BMT Maslahah`\n" + uid
		
		setTimeout(() => kirimDanSimpan(jadi, formatOtp, uid).then((response) => {
			return res.status(200).json({
				status: "SUCCESS",
				// fungsi: "kirimDanSimpan",
				// messages1: response,
				uuid: uid,
				messages: {
					id: response.key.id,
					nomor: String(response.key.remoteJid).split('@')[0],
					text: response.message.extendedTextMessage.text,
					terkirim: response.message.status
				},
			});
		}), delay)

		// let send_message = await sock.sendMessage(id, { text: formatOtp }); //sendMessageWTyping
		// // let send_message = await sendMessageWTyping({ text: req.body.pesan }, id); //sendMessageWTyping
		// simpanPesanToMysql({
		// 	nomor: jadi,
		// 	pesan: formatOtp,
		// 	message_id: send_message.key.id
		// })
		// return res.status(200).json({
		// 	status: "ok",
		// 	message_id: send_message.key.id,
		// 	penerima: id,
		// 	pesan: send_message.message.extendedTextMessage.text,
		// });
	} catch (error) {
		return res.status(400).json({
			status: "ERROR",
			messages: error.message,
		});
	}
};

const simpanPesanToMysql = async (data) => {
	let now = new Date();

	try {
		let formData = {
			nomor: String(data.nomor).length === 0 ? "0888" : data.nomor,
			pesan: String(data.pesan).length === 0 ? "0888" : data.pesan,
			message_id: data.message_id,
			uuid: data.uuid,
			created_at: now.toLocaleString('af-ZA', { timeZone: 'ASIA/Jakarta' })
		}
		const insertDB = db.query('INSERT INTO tik_wa_express SET ?', formData)
		console.log(insertDB);
		
	} catch (error) {
		console.log(error);
		
	}
};
// app.get("/cek/:nomor", cekWa);


// PROTECT ALL ROUTES THAT FOLLOW
/*app.use((req, res, next) => {
  const apiKey = req.get("API-Key");
  const keys = String(process.env.API_KEY).split(",");
  if (!apiKey || !keys.includes(apiKey)) {
	res.status(401).json({ error: "unauthorized" });
	// res.status(401).json({'apikey': apiKey})
  } else {
	next();
  }
});*/

/*app.use(async (req, res, next) => {
  const nomor = req.body.nomor;
  let data = new FormData();
  data.append("target", nomor);
  data.append("countryCode", "62");
  const response = await fetch("https://api.fonnte.com/validate", {
	method: "POST",
	mode: "cors",
	headers: new Headers({
	  Authorization: process.env.FONNTE_TOKEN,
	}),
	body: data,
  });

  const result = await response.json();
  if (result.not_registered[0]) {
	res
	  .status(400)
	  .json({
		error: `nomor telp ${result.not_registered[0]} tidak terdaftar di wa`,
	  });
  } else {
	next();
  }
});*/
app.get("/info", infoMessage);
app.post("/pesan", sendPesan);
app.post("/otp", sendOtp);
// app.get("/hash", async (req, res) => {
// 	const hash = await bcrypt.hash("saya"+tambahan, saltRounds)
// 	const banding = await bcrypt.compare("saya"+tambahan, hash)
// 	const itung = "739d58cf-c215-4418-b132-c625ec7d2bf1"
// 	res.status(200).json({
// 		status: "berhasil",
// 		hash: hash,
// 		cocok: banding,
// 		itung: itung.length
// 	})
// })

// app.use(express.static("public"))

app.listen(port, () => {
	console.log(`server di port ${port}`);
});
