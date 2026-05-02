import http from "node:http";
import path from "node:path";

import express from "express";
import { Server, Socket } from "socket.io";
import {publisher,redis,subscribe} from "./redis-connection.js"

const CHECKBOX_SIZES = 100
const CHECKBOX_STATE_KEY = 'checkbox-state'

async function main() {
    const app = express();
    const server = http.createServer(app);
    const port = process.env.PORT || 8000;

    const io = new Server();
    io.attach(server);
    await subscribe.subscribe("internal-server:checkbox:change")
     subscribe.on("message",(channel,message)=>{
        console.log("SUBSCRIBER RECEIVED:", channel, message);

        if(channel === "internal-server:checkbox:change"){
            // parse it because when we send we strigify it
            const {index,checked} = JSON.parse(message);

            //change the state
            // state.checkboxes[index] = checked

            

            //tell each client about the changes
            io.emit(`server:checkbox:change`,{index,checked})
        }

    })

    // Socket io handlers
    io.on("connection",(socket)=>{
        // console.log(`scoket connection`,{id : socket});

        socket.on("client:checkedbox:change",async (data)=>{
            console.log("PUBLISHING:", data);
            console.log(`Socket : ${socket.id} : client : checkbox:change ${data.checked}`)
            // io.emit(`server:checkbox:change`,data)
            // state.checkboxes[data.index] = data.checked

            const existingState = await redis.get(CHECKBOX_STATE_KEY);

            let stateData;
            if(existingState){
                stateData = JSON.parse(existingState);
            }else{
                stateData = new Array(CHECKBOX_SIZES).fill(false);
            }

            stateData[data.index] = data.checked

            await redis.set(CHECKBOX_STATE_KEY,JSON.stringify(stateData));

            // user ne jo data mere ko send kiya maine vo redis ko send kar diya
            await publisher.publish("internal-server:checkbox:change",JSON.stringify(data))
        })
    })

    app.use(express.static(path.resolve("./public")));

    app.get("/checkboxes",async (req,res)=>{
        const existingState = await redis.get(CHECKBOX_STATE_KEY);
        if(existingState){
            const remoteData = JSON.parse(existingState);
            return res.json({checkboxes : remoteData})
        }
        return res.json({checkboxes : new Array(CHECKBOX_SIZES).fill(false)})
    })

    app.get("/health",(req,res)=> res.json({"health" : true}))

    server.listen(port,()=>{
        console.log(`Server is running on http://localhost:${port}`);
    });
}

main();