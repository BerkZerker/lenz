(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.class
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface
(type_declaration (type_spec name: (type_identifier) @name)) @definition.type
(const_declaration (const_spec name: (identifier) @name)) @definition.const
(var_declaration (var_spec name: (identifier) @name)) @definition.const
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (selector_expression field: (field_identifier) @name)) @reference.call
(import_declaration) @reference.import
(identifier) @reference.ident
(type_identifier) @reference.ident
