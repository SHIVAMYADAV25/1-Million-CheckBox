import http from "node:http";
import path from "node:path";

import express from "express";
import { Server, Socket } from "socket.io";

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

    // Socket io handlers
    io.on("connection",(socket)=>{
        console.log(`scoket connection`,{id : socket});

        socket.on("client:checkedbox:change",(data)=>{
            console.log(`Socket : ${socket.id} : client : checkbox:change ${data.checked}`)
            io.emit(`server:checkbox:change`,data)
            state.checkboxes[data.index] = data.checked
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