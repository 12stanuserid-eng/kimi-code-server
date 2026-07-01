FROM ttl.sh/pentaract-temp:latest
ENV RUST_BACKTRACE=full
ENV RUST_LOG=debug
EXPOSE 10000
ENTRYPOINT ["/pentaract"]
