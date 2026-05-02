import Redis from "ioredis";

const connectRedisServer = () => {
    return new Redis({
        host : "localhost",
        port : 6379
    })
}

const publisher = await connectRedisServer();

const redis = await connectRedisServer()

const subscribe = await  connectRedisServer();

export {
    publisher,
    redis,
    subscribe
}