model
  schema 1.1

type user
type service-account

type role
  relations
    define assignee: [user, service-account, team#member, role#assignee]

type team
  relations
    define admin: [user, service-account]
    define member: [user, service-account] or admin
    define get: [user, service-account, team#member, role#assignee] or member

type folder
  relations
    define parent: [folder]
    define admin: [user, service-account, team#member, role#assignee] or admin from parent
    define edit: [user, service-account, team#member, role#assignee] or edit from parent
    define view: [user, service-account, team#member, role#assignee] or view from parent
    define get: [user, service-account, team#member, role#assignee] or get from parent
    define create: [user, service-account, team#member, role#assignee] or create from parent
    define delete: [user, service-account, team#member, role#assignee] or delete from parent
    define get_permissions: [user, service-account, team#member, role#assignee] or get_permissions from parent
    define set_permissions: [user, service-account, team#member, role#assignee] or set_permissions from parent
    define can_get: admin or edit or view or get
    define can_create: admin or edit or create
    define can_delete: admin or edit or delete
    define can_get_permissions: admin or get_permissions
    define can_set_permissions: admin or set_permissions
    define resource_get: [user with subresource_filter, service-account with subresource_filter, team#member with subresource_filter, role#assignee with subresource_filter] or resource_get from parent
    define resource_create: [user with subresource_filter, service-account with subresource_filter, team#member with subresource_filter, role#assignee with subresource_filter] or resource_create from parent

type resource
  relations
    define admin: [user with group_filter, service-account with group_filter, team#member with group_filter, role#assignee with group_filter]
    define edit: [user with group_filter, service-account with group_filter, team#member with group_filter, role#assignee with group_filter] or admin
    define view: [user with group_filter, service-account with group_filter, team#member with group_filter, role#assignee with group_filter] or edit
    define get: [user with group_filter, service-account with group_filter, team#member with group_filter, role#assignee with group_filter] or view

condition group_filter(requested_group: string, group_resource: string) {
  requested_group == group_resource
}

condition subresource_filter(subresource: string, subresources: list<string>) {
  subresource in subresources
}
