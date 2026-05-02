import http from "node:http";
import path from "node:path";

import express from "express";
import { Server, Socket } from "socket.io";
import {publisher,subscribe} from "./redis-connection.js"

const CHECKBOX_SIZES = 100

const state = {
    checkboxes : new Array(CHECKBOX_SIZES).fill(false)
}

async function main() {
    const app = express();
    const server = http.createServer(app);
    const port = process.env.PORT || 8000;

    const io = new Server();
    io.attach(server);
    (await subscribe).subscribe("internal-server:checkbox:change")
    (await subscribe).on("message",(channel,message)=>{

        if(channel === "internal-server:checkbox:change"){
            // parse it because when we send we strigify it
            const {index,checked} = JSON.parse(message);

            //change the state
            state.checkboxes[index] = checked

            //tell each client about the changes
            io.emit(`server:checkbox:change`,{index,checked})
        }

    })

    // Socket io handlers
    io.on("connection",(socket)=>{
        console.log(`scoket connection`,{id : socket});

        socket.on("client:checkedbox:change",(data)=>{
            console.log(`Socket : ${socket.id} : client : checkbox:change ${data.checked}`)
            // io.emit(`server:checkbox:change`,data)
            // state.checkboxes[data.index] = data.checked


            // user ne jo data mere ko send kiya maine vo redis ko send kar diya
            publisher.publish("internal-server:checkbox:change",JSON.stringify(data))
        })
    })

    app.use(express.static(path.resolve("./public")));

    app.get("/checkboxes",(req,res)=>{
        return res.json({checkboxes : state.checkboxes})
    })

    app.get("/health",(req,res)=> res.json({"health" : true}))

    server.listen(port,()=>{
        console.log(`Server is running on http://localhost:${port}`);
    });
}

main();