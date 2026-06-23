FROM mcr.microsoft.com/playwright:v1.54.2-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
COPY scripts/install-playwright-chromium.js ./scripts/install-playwright-chromium.js
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
