model
  schema 1.1

type user_a5

type us_group_a5
  relations
    define member: [user_a5]

type us_document_a5
  relations
    define viewer: [us_group_a5#member]
    define can_view: viewer
