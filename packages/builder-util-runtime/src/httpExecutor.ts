import { createHash, Hash } from "crypto"
import _debug from "debug"
import { createWriteStream } from "fs-extra-p"
import { IncomingMessage, OutgoingHttpHeaders, RequestOptions } from "http"
import { Socket } from "net"
import { Transform } from "stream"
import { parse as parseUrl, URL } from "url"
import { CancellationToken } from "./CancellationToken"
import { newError } from "./index"
import { ProgressCallbackTransform, ProgressInfo } from "./ProgressCallbackTransform"
import { createGunzip } from "zlib"

const debug = _debug("electron-builder")

export interface RequestHeaders extends OutgoingHttpHeaders {
  [key: string]: string
}

export interface DownloadOptions {
  readonly headers?: OutgoingHttpHeaders | null
  readonly skipDirCreation?: boolean
  readonly sha2?: string | null
  readonly sha512?: string | null

  readonly cancellationToken: CancellationToken

  // noinspection JSUnusedLocalSymbols
  onProgress?(progress: ProgressInfo): void
}

export function createHttpError(response: IncomingMessage, description: any | null = null) {
  return new HttpError(response.statusCode || -1, `${response.statusCode} ${response.statusMessage}` + (description == null ? "" : ("\n" + JSON.stringify(description, null, "  "))) + "\nHeaders: " + safeStringifyJson(response.headers), description)
}

const HTTP_STATUS_CODES = new Map<number, string>([
  [429, "Too many requests"],
  [400, "Bad request"],
  [403, "Forbidden"],
  [404, "Not found"],
  [405, "Method not allowed"],
  [406, "Not acceptable"],
  [408, "Request timeout"],
  [413, "Request entity too large"],
  [500, "Internal server error"],
  [502, "Bad gateway"],
  [503, "Service unavailable"],
  [504, "Gateway timeout"],
  [505, "HTTP version not supported"],
])

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string = `HTTP error: ${HTTP_STATUS_CODES.get(statusCode) || statusCode}`, readonly description: any | null = null) {
    super(message)

    this.name = "HttpError"
  }
}

export function parseJson(result: Promise<string | null>) {
  return result.then(it => it == null || it.length === 0 ? null : JSON.parse(it))
}

export abstract class HttpExecutor<REQUEST> {
  protected readonly maxRedirects = 10

  request(options: RequestOptions, cancellationToken: CancellationToken = new CancellationToken(), data?: { [name: string]: any; } | null): Promise<string | null> {
    configureRequestOptions(options)
    const encodedData = data == null ? undefined : Buffer.from(JSON.stringify(data))
    if (encodedData != null) {
      options.method = "post"
      options.headers!["Content-Type"] = "application/json"
      options.headers!["Content-Length"] = encodedData.length
    }
    return this.doApiRequest(options, cancellationToken, it => {
      (it as any).end(encodedData)
    })
  }

  doApiRequest(options: RequestOptions, cancellationToken: CancellationToken, requestProcessor: (request: REQUEST, reject: (error: Error) => void) => void, redirectCount: number = 0): Promise<string> {
    if (debug.enabled) {
      debug(`Request: ${safeStringifyJson(options)}`)
    }

    return cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      const request = this.doRequest(options, (response: any) => {
        try {
          this.handleResponse(response, options, cancellationToken, resolve, reject, redirectCount, requestProcessor)
        }
        catch (e) {
          reject(e)
        }
      })
      this.addErrorAndTimeoutHandlers(request, reject)
      this.addRedirectHandlers(request, options, reject, redirectCount, options => {
        this.doApiRequest(options, cancellationToken, requestProcessor, redirectCount)
          .then(resolve)
          .catch(reject)
      })
      requestProcessor(request, reject)
      onCancel(() => request.abort())
    })
  }

  // noinspection JSUnusedLocalSymbols
  protected addRedirectHandlers(request: any, options: RequestOptions, reject: (error: Error) => void, redirectCount: number, handler: (options: RequestOptions) => void) {
    // not required for NodeJS
  }

  addErrorAndTimeoutHandlers(request: any, reject: (error: Error) => void) {
    this.addTimeOutHandler(request, reject)
    request.on("error", reject)
    request.on("aborted", () => {
      reject(new Error("Request has been aborted by the server"))
    })
  }

  private handleResponse(response: IncomingMessage,
                         options: RequestOptions,
                         cancellationToken: CancellationToken,
                         resolve: (data?: any) => void,
                         reject: (error: Error) => void,
                         redirectCount: number, requestProcessor: (request: REQUEST, reject: (error: Error) => void) => void) {
    if (debug.enabled) {
      debug(`Response: ${response.statusCode} ${response.statusMessage}, request options: ${safeStringifyJson(options)}`)
    }

    // we handle any other >= 400 error on request end (read detailed message in the response body)
    if (response.statusCode === 404) {
      // error is clear, we don't need to read detailed error description
      reject(createHttpError(response, `method: ${options.method} url: ${options.protocol || "https:"}//${options.hostname}${options.path}

Please double check that your authentication token is correct. Due to security reasons actual status maybe not reported, but 404.
`))
      return
    }
    else if (response.statusCode === 204) {
      // on DELETE request
      resolve()
      return
    }

    const redirectUrl = safeGetHeader(response, "location")
    if (redirectUrl != null) {
      if (redirectCount > 10) {
        reject(new Error("Too many redirects (> 10)"))
        return
      }

      this.doApiRequest(HttpExecutor.prepareRedirectUrlOptions(redirectUrl, options), cancellationToken, requestProcessor, redirectCount)
        .then(resolve)
        .catch(reject)
      return
    }

    let stream: NodeJS.ReadableStream = response
    if ((options as any).gzip) {
      const gUnzip = createGunzip()
      gUnzip.on("error", reject)
      response.pipe(gUnzip)
      stream = gUnzip
    }
    stream.setEncoding("utf8")

    let data = ""
    stream.on("data", (chunk: string) => data += chunk)
    stream.on("end", () => {
      try {
        if (response.statusCode != null && response.statusCode >= 400) {
          const contentType = safeGetHeader(response, "content-type")
          const isJson = contentType != null && (Array.isArray(contentType) ? contentType.find(it => it.includes("json")) != null : contentType.includes("json"))
          reject(createHttpError(response, isJson ? JSON.parse(data) : data))
        }
        else {
          resolve(data.length === 0 ? null : data)
        }
      }
      catch (e) {
        reject(e)
      }
    })
  }

  // noinspection JSUnusedLocalSymbols
  abstract doRequest(options: any, callback: (response: any) => void): any

  protected doDownload(requestOptions: any, destination: string, redirectCount: number, options: DownloadOptions, callback: (error: Error | null) => void, onCancel: (callback: () => void) => void) {
    const request = this.doRequest(requestOptions, (response: IncomingMessage) => {
      if (response.statusCode! >= 400) {
        callback(new Error(`Cannot download "${requestOptions.protocol || "https:"}//${requestOptions.hostname}${requestOptions.path}", status ${response.statusCode}: ${response.statusMessage}`))
        return
      }

      const redirectUrl = safeGetHeader(response, "location")
      if (redirectUrl != null) {
        if (redirectCount < this.maxRedirects) {
          this.doDownload(HttpExecutor.prepareRedirectUrlOptions(redirectUrl, requestOptions), destination, redirectCount++, options, callback, onCancel)
        }
        else {
          callback(new Error(`Too many redirects (> ${this.maxRedirects})`))
        }
        return
      }

      configurePipes(options, response, destination, callback, options.cancellationToken)
    })
    this.addErrorAndTimeoutHandlers(request, callback)
    this.addRedirectHandlers(request, requestOptions, callback, redirectCount, requestOptions => {
      this.doDownload(requestOptions, destination, redirectCount++, options, callback, onCancel)
    })
    onCancel(() => request.abort())
    request.end()
  }

  protected addTimeOutHandler(request: any, callback: (error: Error) => void) {
    request.on("socket", (socket: Socket) => {
      socket.setTimeout(60 * 1000, () => {
        callback(new Error("Request timed out"))
        request.abort()
      })
    })
  }

  static prepareRedirectUrlOptions(redirectUrl: string, options: RequestOptions): RequestOptions {
    const newOptions = configureRequestOptionsFromUrl(redirectUrl, {...options})
    const headers = newOptions.headers
    if (headers != null && headers.authorization != null && (headers.authorization as string).startsWith("token")) {
      const parsedNewUrl = new URL(redirectUrl)
      if (parsedNewUrl.hostname.endsWith(".amazonaws.com")) {
        delete headers.authorization
      }
    }
    return newOptions
  }
}

export function configureRequestOptionsFromUrl(url: string, options: RequestOptions) {
  const parsedUrl = parseUrl(url)
  options.protocol = parsedUrl.protocol
  options.hostname = parsedUrl.hostname
  if (parsedUrl.port == null) {
    if (options.port != null) {
      delete options.port
    }
  }
  else {
    options.port = parsedUrl.port
  }
  options.path = parsedUrl.path
  return configureRequestOptions(options)
}

export class DigestTransform extends Transform {
  private readonly digester: Hash

  private _actual: string | null = null

  // noinspection JSUnusedGlobalSymbols
  get actual() {
    return this._actual
  }

  isValidateOnEnd: boolean = true

  constructor(readonly expected: string, private readonly algorithm: string = "sha512", private readonly encoding: "hex" | "base64" | "latin1" = "base64") {
    super()

    this.digester = createHash(algorithm)
  }

  // noinspection JSUnusedGlobalSymbols
  _transform(chunk: Buffer, encoding: string, callback: any) {
    this.digester.update(chunk)
    callback(null, chunk)
  }

  // noinspection JSUnusedGlobalSymbols
  _flush(callback: any): void {
    this._actual = this.digester.digest(this.encoding)

    if (this.isValidateOnEnd) {
      try {
        this.validate()
      }
      catch (e) {
        callback(e)
        return
      }
    }

    callback(null)
  }

  validate() {
    if (this._actual == null) {
      throw newError("Not finished yet", "ERR_STREAM_NOT_FINISHED")
    }

    if (this._actual !== this.expected) {
      throw newError(`${this.algorithm} checksum mismatch, expected ${this.expected}, got ${this._actual}`, "ERR_CHECKSUM_MISMATCH")
    }

    return null
  }
}

function checkSha2(sha2Header: string | null | undefined, sha2: string | null | undefined, callback: (error: Error | null) => void): boolean {
  if (sha2Header != null && sha2 != null) {
    // todo why bintray doesn't send this header always
    if (sha2Header == null) {
      callback(new Error("checksum is required, but server response doesn't contain X-Checksum-Sha2 header"))
      return false
    }
    else if (sha2Header !== sha2) {
      callback(new Error(`checksum mismatch: expected ${sha2} but got ${sha2Header} (X-Checksum-Sha2 header)`))
      return false
    }
  }
  return true
}

export function safeGetHeader(response: any, headerKey: string) {
  const value = response.headers[headerKey]
  if (value == null) {
    return null
  }
  else if (Array.isArray(value)) {
    // electron API
    return value.length === 0 ? null : value[value.length - 1]
  }
  else {
    return value
  }
}

function configurePipes(options: DownloadOptions, response: any, destination: string, callback: (error: Error | null) => void, cancellationToken: CancellationToken) {
  if (!checkSha2(safeGetHeader(response, "X-Checksum-Sha2"), options.sha2, callback)) {
    return
  }

  const streams: Array<any> = []
  if (options.onProgress != null) {
    const contentLength = safeGetHeader(response, "content-length")
    if (contentLength != null) {
      streams.push(new ProgressCallbackTransform(parseInt(contentLength, 10), options.cancellationToken, options.onProgress))
    }
  }

  const sha512 = options.sha512
  if (sha512 != null) {
    streams.push(new DigestTransform(sha512, "sha512", sha512.length === 128 && !sha512.includes("+") && !sha512.includes("Z") && !sha512.includes("=") ? "hex" : "base64"))
  }
  else if (options.sha2 != null) {
    streams.push(new DigestTransform(options.sha2, "sha256", "hex"))
  }

  const fileOut = createWriteStream(destination)
  streams.push(fileOut)

  let lastStream = response
  for (const stream of streams) {
    stream.on("error", (error: Error) => {
      if (!cancellationToken.cancelled) {
        callback(error)
      }
    })
    lastStream = lastStream.pipe(stream)
  }

  fileOut.on("finish", () => {
    (fileOut.close as any)(callback)
  })
}

export function configureRequestOptions(options: RequestOptions, token?: string | null, method?: "GET" | "DELETE" | "PUT"): RequestOptions {
  if (method != null) {
    options.method = method
  }

  let headers = options.headers
  if (headers == null) {
    headers = {}
    options.headers = headers
  }
  if (token != null) {
    (headers as any).authorization = token.startsWith("Basic") ? token : `token ${token}`
  }
  if (headers["User-Agent"] == null) {
    headers["User-Agent"] = "electron-builder"
  }

  if ((method == null || method === "GET") || headers["Cache-Control"] == null) {
    headers["Cache-Control"] = "no-cache"
  }

  // do not specify for node (in any case we use https module)
  if (options.protocol == null && (process.versions as any).electron != null) {
    options.protocol = "https:"
  }
  return options
}

export function safeStringifyJson(data: any, skippedNames?: Set<string>) {
  return JSON.stringify(data, (name, value) => {
    if (name.endsWith("authorization") || name.endsWith("Password") || name.endsWith("PASSWORD") || name.endsWith("Token") || name.includes("password") || name.includes("token") || (skippedNames != null && skippedNames.has(name))) {
      return "<stripped sensitive data>"
    }
    return value
  }, 2)
}