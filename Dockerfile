FROM ttl.sh/pentaract-temp:latest
EXPOSE 10000
ENV RUST_BACKTRACE=full
ENV RUST_LOG=debug
ENTRYPOINT ["/pentaract"]
