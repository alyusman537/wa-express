const {
  makeWASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("sessions/wa");
  sock = makeWASocket({
    // can provide additional config here
    printQRInTerminal: true,
    auth: state,
    browser: Browsers.macOS("Chrome"),
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    // let _a, _b;
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        "connection closed due to ",
        lastDisconnect.error,
        ", reconnecting ",
        shouldReconnect
      );
      // reconnect if not logged out
      if (shouldReconnect) {
        connectToWhatsApp();
        console.log('ini sock', JSON.stringify(sock));
      } else {
        console.log("connection closed");
        fs.rmdir(`sessions/wa`, { recursive: true }, (err) => {
          if (err) {
            throw err;
          }
          console.log(`session is deleted`);
        });
      }
    } else if (connection === "open") {
      console.log("opened connection");
    }
  });
}
// run in main file
connectToWhatsApp();

const app = express();
const port = 3000;
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const infoMessage = (req, res) => {
    try {
        return res.status(200).json({
            status: 'OK',
            pesan: {
                info: {
                    url: 'kirim-pesan',
                    method: 'get',
                    keterangan: 'informasi menganai API WA'
                },
                kirim_pesan: {
                    url: 'kirim-pesan',
                    method: 'post',
                    keterangan: 'harus menyertakan body nomor dan pesan'
                }
            }
        })
    } catch (error) {
        return res.status(400).json({
            'status': 'ERROR',
            'pesan': error.message
        })
    }
}

const cekWa = async (req, res) => {
    try {
        let hp = req.body.nomor;
    let pesan = req.body.pesan;
    let delay = req.body.delay ? parseInt(req.body.delay) * 1000 : 2000;
    if (!hp || !pesan) {
      return res.status(400).json({
        status: "ERROR",
        messages: "nomor wa dan isi pesan tidak boleh kosong",
      });
    }
    let jadi = "";
    if (hp.substring(0, 2) == "08") {
      jadi = `62${hp.substring(1)}`;
    } else if (hp.substring(0, 2) == "62") {
      jadi = hp;
    }
    const id = jadi + "@s.whatsapp.net"; // the WhatsApp ID
        const cek = await sock.sendPresenceUpdate("available", id);
        return res.status(200).json({
            status: 'OK',
            hasil: cek
        })
    } catch (error) {
        return res.status(400).json({
            status: 'ERROR',
            hasil: error.message
        })
    }
}

const sendMessage = async (req, res) => {
  try {
    let hp = req.body.nomor;
    let pesan = req.body.pesan;
    let delay = req.body.delay ? parseInt(req.body.delay) * 1000 : 2000;
    if (!hp || !pesan) {
      return res.status(400).json({
        status: "ERROR",
        messages: "nomor wa dan isi pesan tidak boleh kosong",
      });
    }
    let jadi = "";
    if (hp.substring(0, 2) == "08") {
      jadi = `62${hp.substring(1)}`;
    } else if (hp.substring(0, 2) == "62") {
      jadi = hp;
    }
    const id = jadi + "@s.whatsapp.net"; // the WhatsApp ID
    let send_message = await sock.sendMessage(id, { text: req.body.pesan });
    return res.status(200).json({
      status: "ok",
      message_id: send_message.key.id,
      penerima: id,
      pesan: send_message,
    });
  } catch (error) {
    return res.status(400).json({
      status: "ERROR",
      messages: error.message,
    });
  }
};

app.get("/cek", cekWa);
app.get("/kirim-pesan", infoMessage);
app.post("/kirim-pesan", sendMessage);

app.listen(port, () => {
  console.log(`server di port ${port}`);
});
