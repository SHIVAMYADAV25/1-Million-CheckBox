import Redis from "ioredis";

const connectRedisServer = async () => {
    return new Redis({
        host : "localhost",
        port : 6379
    })
}

const publisher =  connectRedisServer();

const redis =  connectRedisServer()

const subscribe =   connectRedisServer();

export {
    publisher,
    redis,
    subscribe
}