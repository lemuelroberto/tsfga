model
  schema 1.1

type user_d3c

type doc_d3c
  relations
    define viewer: [user_d3c with equal_d3c]
    define member: [user_d3c with member_d3c]

condition equal_d3c(x: string, y: string) {
  x == y
}

condition member_d3c(needle: string, haystack: list<string>) {
  needle in haystack
}
