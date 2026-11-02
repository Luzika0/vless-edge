FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
ENV NODE_ENV=production
EXPOSE 8443/tcp
CMD ["npm", "start"]
