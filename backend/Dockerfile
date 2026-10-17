# Backend image: static binary on distroless, data in /data.
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/server ./cmd/server \
    && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
COPY --from=build --chown=65532:65532 /out/data /data
ENV APP_ADDR=:8080 \
    APP_DB_PATH=/data/app.db
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/server"]
