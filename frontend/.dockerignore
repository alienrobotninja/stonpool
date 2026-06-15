FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# vite inlines these at build; the env guard fails the build if the required ones are unset
ARG VITE_APP_URL
ARG VITE_API_BASE_URL
ARG VITE_NETWORK=testnet
ARG VITE_POOL_CORE_ADDRESS
ARG VITE_FAUCET_ADDRESS
ARG VITE_JETTON_MINTER_ADDRESS
ARG VITE_ADAPTER_ADDRESS
ENV VITE_APP_URL=$VITE_APP_URL \
    VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_NETWORK=$VITE_NETWORK \
    VITE_POOL_CORE_ADDRESS=$VITE_POOL_CORE_ADDRESS \
    VITE_FAUCET_ADDRESS=$VITE_FAUCET_ADDRESS \
    VITE_JETTON_MINTER_ADDRESS=$VITE_JETTON_MINTER_ADDRESS \
    VITE_ADAPTER_ADDRESS=$VITE_ADAPTER_ADDRESS
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80