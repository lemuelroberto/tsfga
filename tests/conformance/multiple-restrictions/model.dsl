model
  schema 1.1

type user

type organization
  relations
    define member: [user]

type document
  relations
    define owner: [organization]
    define writer: [user]
    define can_write: writer
    define can_delete: writer and member from owner
