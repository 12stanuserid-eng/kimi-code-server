FROM diegosouzapw/omniroute:latest

ENV PORT=10000
EXPOSE 10000

CMD ["omniroute", "serve"]
